import { Context, Schema, Session, h } from 'koishi'
import {} from '@koishijs/plugin-help'
import {} from '@koishijs/plugin-callme'
import {} from 'koishi-plugin-w-echarts'

import dayjs from 'dayjs'

export const name = 'w-dice'

export const inject = [ 'database', 'echarts' ]

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

declare module 'koishi' {
    interface Tables {
        'w-jrrp-record': JrrpRecord
        'w-jrrp-name': JrrpName
    }
}

export interface JrrpRecord {
    id: number
    uid: string
    day: number
    rp: number
}

export interface JrrpName {
    uid: string
    name: string
}

export function apply(ctx: Context) {
    ctx.model.extend('w-jrrp-record', {
        id: 'unsigned',
        uid: 'string',
        day: 'unsigned',
        rp: 'unsigned'
    }, {
        autoInc: true
    })

    ctx.model.extend('w-jrrp-name', {
        uid: 'string',
        name: 'string'
    }, {
        primary: 'uid'
    })

    function getUsername({ event: { user } }: Session) {
        return user.nick || user.name
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
            const name = getUsername(session)
            ctx.database.upsert('w-jrrp-name', () => [ { uid, name } ])

            const today = + dayjs(new Date).startOf('day')
            const [ rec ] = await ctx.database.get('w-jrrp-record', { uid, day: today })

            if (rec) return `${name} 今天已经测过人品啦，是 ${rec.rp}，再怎么测都不会变的了啦……`

            const rp = Math.floor(Math.random() * 101)
            await ctx.database.create('w-jrrp-record', { uid, day: today, rp })
            return `${name} 今天的人品是 ${rp}`
        })

    ctx.on('common/callme', (name, { uid }) => {
        ctx.database.set('w-jrrp-name', { uid }, { name })
    })

    ctx.command('jrrp.top', '查看群内今日人品排行')
        .option('max', '-m <max:number> 设置最大显示人数', { fallback: 10 })
        .option('global', '-G 查看全局排行榜（所有群）', { hidden: true })
        .option('reverse', '-r 逆序显示')
        .option('chart', '-c 显示图表', { fallback: true })
        .option('chart', '-C 不显示图表（文本形式）', { value: false })
        .alias('jrrp.bottom', { options: { reverse: true } })
        .action(async ({ session, options }) => {
            const { uid, guildId: gid } = session
            const name = getUsername(session)

            if (! gid && ! options.global) return '请在群内调用'

            const { data: members } = await session.bot.getGuildMemberList(gid)

            const today = + dayjs(new Date).startOf('day')
            const list = await ctx.database.get('w-jrrp-record', { day: today })
            const topAll = (await Promise
                .all(list.map(async ({ uid, rp }) => {
                    const [ userPlatform, userId ] = uid.split(':')
                    if (! options.global &&
                        userPlatform !== session.event.platform &&
                        ! members.some(member => member.user.id === userId)
                    ) return null
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

            if (! topAll.length) return '今天还没有人测过人品哦'
            
            const top = topAll.slice(0, options.max || undefined)
            const rank = top.findIndex(rec => rec.uid === uid) + 1
            const rankMsg = rank
                ? `今日人品排名是${options.reverse ? '倒数' : ''}第 ${rank}`
                : topAll.some(rec => rec.uid === uid)
                    ? `今日人品未上榜`
                    : `今日还没有测过人品`

            if (! options.chart) return `${name} ${rankMsg}\n今日人品排行榜\n` + top
                .map((rec, i) => `${rec.uid === uid ? '＊' : '　'} ${i + 1}. ${rec.name}: ${rec.rp}`)
                .join('\n')

            top.reverse() // ECharts 图表顺序从下向上

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
                    data: top.map(rec => rec.name)
                },
                series: {
                    type: 'bar',
                    data: top.map(rec => ({
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
        .get('w-jrrp-record', { uid }))
        .sort((rec1, rec2) => rec1.day - rec2.day)
        .map(({ day, rp }) => ({
            day: dayjs(day).format('YYYY-MM-DD'),
            rp
        }))

    type LineSeriesOption = echarts.RegisteredSeriesOption['line']
    
    const getJrrpSeries = (recs: Awaited<ReturnType<typeof getJrrpRecs>>, color: string): LineSeriesOption => ({
        type: 'line',
        data: recs.map(({ day, rp }) => [ day, rp.toFixed(2) ] as const),
        label: { show: true },
        lineStyle: { color },
        itemStyle: { color }
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
