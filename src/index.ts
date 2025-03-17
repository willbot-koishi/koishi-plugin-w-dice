import { $, Context, Schema as z, Session, h } from 'koishi'
import {} from '@koishijs/plugin-help'
import {} from '@koishijs/plugin-callme'
import {} from 'koishi-plugin-w-echarts'

import dayjs from 'dayjs'
import dayjsCustomParseFormatPlugin from 'dayjs/plugin/customParseFormat'
dayjs.extend(dayjsCustomParseFormatPlugin)

export const name = 'w-dice'

export const inject = [ 'database', 'echarts' ]

export interface RpEvent {
    on: {
        year?: number
        month?: number
        date?: number
    }
    rp: number
    reason: string
}

export interface Config {
    rpEvents: RpEvent[]
}

export const Config: z<Config> = z.object({
    rpEvents: z.array(z.object({
        on: z.object({
            year: z.number(),
            month: z.number(),
            date: z.number()
        }).required(),
        rp: z.number().required(),
        reason: z.string().required()
    }))
})

declare module 'koishi' {
    interface Tables {
        'w-jrrp-record': JrrpRecord_v1
        'w-jrrp-record-v2': JrrpRecord_v2
        'w-jrrp-name': JrrpName
    }
}

export interface JrrpRecord_v1 {
    id: number
    uid: string
    day: number
    rp: number
}

export interface JrrpRecord_v2 {
    uid: string
    day: string
    rp: number
}

export type JrrpRecord = JrrpRecord_v2

export interface JrrpName {
    uid: string
    name: string
}

export function apply(ctx: Context, config: Config) {
    ctx.model.extend('w-jrrp-record', {
        id: 'unsigned',
        uid: 'string',
        day: 'unsigned',
        rp: 'unsigned'
    }, {
        autoInc: true
    })

    ctx.model.extend('w-jrrp-record-v2', {
        uid: 'string',
        day: 'string',
        rp: 'unsigned'
    }, {
        primary: [ 'uid', 'day' ]
    })

    ctx.model.extend('w-jrrp-name', {
        uid: 'string',
        name: 'string'
    }, {
        primary: 'uid'
    })

    async function getUsername({ uid, event: { user } }: Session) {
        const [ { name: customName } ] = await ctx.database.get('w-jrrp-name', uid)
        return customName || user.nick || user.name
    }

    const colors = {
        primary: '#73b9bc',
        secondary: '#91ca8c',
        tertiary: '#d48265',
        accent: '#f49f42'
    } as const

    ctx.command('jrrp', '查看今日人品')
        .action(async ({ session }) => {
            const { uid } = session

            const d = dayjs()
            const day = d.format('YYYY-MM-DD')

            const [ name, [ rec ] ] = await Promise.all([
                getUsername(session),
                ctx.database.get('w-jrrp-record-v2', { uid, day })
            ])

            const rpEvent = config.rpEvents.find(({ on }) => {
                if ('year' in on && on.year !== d.year()) return false
                if ('month' in on && on.month !== d.month() + 1) return false
                if ('date' in on && on.date !== d.date()) return false
                return true
            })

            if (rpEvent) {
                await ctx.database.upsert('w-jrrp-record-v2', [ { uid, day, rp: rpEvent.rp } ])
                return `${name} 今天的人品是 ${rpEvent.rp}，因为${rpEvent.reason}`
            }

            if (rec) return `${name} 今天已经测过人品啦，是 ${rec.rp}，再怎么测都不会变的了啦……`

            const rp = Math.floor(Math.random() * 101)
            await ctx.database.create('w-jrrp-record-v2', { uid, day, rp })
            return `${name} 今天的人品是 ${rp}`
        })

    ctx.command('jrrp.average', '查看我的人品均值')
        .action(async ({ session }) => {
            const { uid } = session
            const [ name, averageRp ] = await Promise.all([
                getUsername(session),
                ctx.database
                    .select('w-jrrp-record-v2')
                    .where({ uid })
                    .execute(row => $.avg(row.rp))
            ])
            return `${name} 的平均人品是 ${averageRp.toFixed(2)}`
        })

    ctx.command('jrrp.callme <name:string>', '修改自己的称呼')
        .action(async ({ session: { uid } }, name) => {
            await ctx.database.set('w-jrrp-name', { uid }, { name })
            return `好的，${name}，请多指教！`
        })

    ctx.command('jrrp.top', '查看群内今日人品排行')
        .option('max', '-m <max:number> 设置最大显示人数', { fallback: Infinity })
        .option('global', '-G 查看全局排行榜（所有群）', { hidden: true })
        .option('reverse', '-r 逆序显示')
        .option('chart', '-c 显示图表', { fallback: true })
        .option('chart', '-C 不显示图表（文本形式）', { value: false })
        .alias('jrrp.bottom', { options: { reverse: true } })
        .action(async ({ session, options }) => {
            const { uid, guildId: gid } = session

            if (! gid && ! options.global) return '请在群内调用'

            const today = dayjs().format('YYYY-MM-DD')

            const [ name, { data: members }, list ] = await Promise.all([
                getUsername(session),
                session.bot.getGuildMemberList(gid),
                ctx.database.get('w-jrrp-record-v2', { day: today })
            ])

            const sortedList = (await Promise
                .all(list.map(async ({ uid, rp }) => {
                    const [ userPlatform, userId ] = uid.split(':')
                    if (! options.global && (
                        userPlatform !== session.event.platform ||
                        ! members.some(member => member.user.id === userId)
                    )) return null
                    const [ rec ] = await ctx.database.get('w-jrrp-name', { uid })
                    const name = rec?.name ?? uid
                    return {
                        uid, name, rp
                    }
                })))
                .filter(rec => !! rec)
                .sort(options.reverse
                    ? (rec1, rec2) => rec1.rp - rec2.rp
                    : (rec1, rec2) => rec2.rp - rec1.rp
                )

            if (! sortedList.length) return `${name} 今天还没有人测过人品哦`
            
            const topList = sortedList.slice(0, options.max || undefined)

            const rp = topList.find(rec => rec.uid === uid)?.rp ?? null
            const rank = rp === null ? null : topList.findIndex(rec => rec.rp === rp) + 1
            const rankMsg = `${name} ` + (rank !== null
                ? `今日人品排名是${options.reverse ? '倒数' : ''}第 ${rank}`
                : sortedList.some(rec => rec.uid === uid)
                    ? `今日人品未上榜`
                    : `今日还没有测过人品`
            )

            if (! options.chart) return `${rankMsg}\n今日人品排行榜\n` + topList
                .map((rec, i) => `${rec.uid === uid ? '＊' : '　'} ${i + 1}. ${rec.name}: ${rec.rp}`)
                .join('\n')

            topList.reverse() // ECharts 图表顺序从下向上

            const eh = ctx.echarts.createChart(800, 500, {
                xAxis: {
                    type: 'value',
                    name: '人品',
                    min: 0,
                    max: 100
                },
                yAxis: {
                    type: 'category',
                    name: '用户',
                    data: topList.map(rec => rec.name)
                },
                series: {
                    type: 'bar',
                    data: topList.map(rec => ({
                        value: rec.rp,
                        itemStyle: { color: rec.uid === uid ? colors.accent : colors.primary }
                    })),
                    label: { show: true },
                },
                backgroundColor: '#fff'
            })

            return [
                h.text(rankMsg),
                await eh.export()
            ]
        })

    const getJrrpRecs = async (uid: string) => (await ctx.database
        .get('w-jrrp-record-v2', { uid }))
        .sort((rec1, rec2) => + dayjs(rec1.day) - + dayjs(rec2.day))

    type LineSeriesOption = echarts.RegisteredSeriesOption['line']
    
    const getJrrpSeries = (recs: Awaited<ReturnType<typeof getJrrpRecs>>, color: string): LineSeriesOption => ({
        type: 'line',
        data: recs.map(({ day, rp }) => [ day, String(rp) ] as const),
        label: { show: true },
        lineStyle: { color },
        itemStyle: { color }
    })

    ctx.command('jrrp.calendar [month:string]', '查看我的人品日历')
        .action(async ({ session }, month) => {
            const { uid } = session

            const date = month ? dayjs(month, 'YYYY-MM', true) : dayjs()
            if (! date.isValid()) return `${month} 不是合法的月份，月份格式应为 YYYY-MM`
            month = date.format('YYYY-MM')

            const [ name, data ] = await Promise.all([
                getUsername(session),
                ctx.database
                .get('w-jrrp-record-v2', {
                    uid,
                    day: { $regex: `^${month}-` }
                }).then(recs => recs
                    .map(rec => [ rec.day, rec.rp ])
                )
            ])

            const eh = ctx.echarts.createChart(420, 320, {
                calendar: {
                    orient: 'vertical',
                    yearLabel: {
                        margin: 40,
                        color: '#000',
                        fontSize: 22,
                        fontWeight: 800,
                    },
                    monthLabel: {
                        nameMap: 'cn',
                        margin: 20,
                        fontSize: 20,
                        fontWeight: 600
                    },
                    dayLabel: {
                        nameMap: [ 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat' ],
                        firstDay: 1,
                        fontSize: 17
                    },
                    cellSize: 40,
                    range: month
                },
                visualMap: {
                    min: 0,
                    max: 100,
                    calculable: true,
                    show: false
                },
                series: {
                    type: 'heatmap',
                    silent: true,
                    label: {
                        show: true,
                        formatter: ({ data }) => String(data[1])
                    },
                    coordinateSystem: 'calendar',
                    data
                },
                backgroundColor: '#fff'
            })

            return [
                `${name} 在 ${month} 的人品日历`,
                await eh.export()
            ]
        })

    ctx.command('jrrp.history', '查看我的人品历史')
        .option('chart', '-c 显示图表', { fallback: true })
        .option('chart', '-C 不显示图表（文本形式）', { value: false })
        .option('diff', '-d <target:user> 指定比较的用户')
        .option('average', '-a [window:posint] 显示均线，可指定窗口大小')
        .action(async ({
            session,
            options: { diff: diffTarget, chart: useChart, average: averageWindowLength }
        }) => {
            if (diffTarget && ! useChart) return 'diff 选项必须在图表模式下使用'

            const { uid } = session
            const [ selfRecs, targetRecs ] = await Promise.all([ // todo: perf
                getJrrpRecs(uid),
                diffTarget ? getJrrpRecs(diffTarget) : undefined
            ])

            if (! useChart) return selfRecs
                .map(({ day, rp }) => `${ dayjs(day).format('YYYY-MM-DD') }: ${rp}`)
                .join('\n') || '你还没有历史人品'

            const eh = ctx.echarts.createChart(800, 500, {})

            const series: LineSeriesOption[] = [ getJrrpSeries(selfRecs, colors.primary) ]
            if (diffTarget) series.push(getJrrpSeries(targetRecs, colors.secondary))
            if (averageWindowLength) {
                const totalLength = selfRecs.length
                if (averageWindowLength > totalLength) return `平均窗口长度不能超过数据总长度（${totalLength}）`

                const averageRecs = []
                const averageWindow = selfRecs.slice(0, averageWindowLength).map(it => it.rp)
                let sum = averageWindow.reduce((a, c) => a + c, 0)
                let i = averageWindowLength - 1
                while (true) {
                    const average = sum / averageWindowLength
                    averageRecs.push({ day: selfRecs[i].day, rp: average })

                    sum -= averageWindow.shift()
                    if (i + 1 === selfRecs.length) break
                    const next = selfRecs[++ i].rp
                    sum += next
                    averageWindow.push(next)
                }

                series.push({
                    ...getJrrpSeries(averageRecs, colors.tertiary),
                    smooth: true,
                    label: { show: false }
                })
            }

            eh.chart.setOption({
                xAxis: {
                    type: 'category',
                    data: [ ...new Set([
                        ...selfRecs.map(rec => rec.day),
                        ...targetRecs?.map(rec => rec.day) ?? []
                    ]) ].sort((day1, day2) => + dayjs(day1) - + dayjs(day2))
                },
                yAxis: {
                    type: 'value',
                    name: '人品',
                    min: 0,
                    max: 100
                },
                series,
                backgroundColor: '#fff'
            } satisfies echarts.EChartsOption)

            return eh.export()
        })
}
