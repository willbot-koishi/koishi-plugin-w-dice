import { Context, Schema, Session, h } from 'koishi'
import {} from '@koishijs/plugin-help'
import {} from '@koishijs/plugin-callme'
import {} from 'koishi-plugin-skia-canvas'

import dayjs from 'dayjs'
import * as echarts from 'echarts'

export const name = 'w-dice'

export const inject = [ 'database', 'canvas' ]

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

declare module 'koishi' {
    interface Tables {
        'w-jrrp-record': WJrrpRecord
        'w-jrrp-name': WJrrpName
    }
}

export interface WJrrpRecord {
    id: number
    uid: string
    day: number
    rp: number
}

export interface WJrrpName {
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

    function createChart(ctx: Context, width: number, height: number) {
        const canvas = ctx.canvas.createCanvas(width, height)
        const chart = echarts.init(canvas as any)
        chart.setOption({
            textStyle: {
                fontFamily: ctx.canvas.getPresetFont()
            }
        })
        return { canvas, chart }
    }

    ctx.command('jrrp', '查看今日人品')
        .action(async ({ session }) => {
            const uid = session.userId
            const name = getUsername(session)
            ctx.database.upsert('w-jrrp-name', () => [ { uid, name } ])

            const today = + dayjs(new Date).startOf('day')
            const [ rec ] = await ctx.database.get('w-jrrp-record', { uid, day: today })

            if (rec) return `${name} 今天已经测过人品啦，是 ${rec.rp}，再怎么测都不会变的了啦……`

            const rp = Math.floor(Math.random() * 100)
            await ctx.database.create('w-jrrp-record', { uid, day: today, rp })
            return `${name} 今天的人品是 ${rp}`
        })

    ctx.on('common/callme', (name, session) => {
        ctx.database.set('w-jrrp-name', { uid: session.userId }, { name })
    })

    ctx.command('jrrp.top', '查看群内今日人品排行')
        .option('max', '-m <max: string>', { fallback: 10 })
        .option('global', '-g', { hidden: true })
        .option('reverse', '-r')
        .option('chart', '-c', { fallback: true })
        .option('chart', '-C', { value: false })
        .alias('jrrp.bottom', { options: { reverse: true } })
        .action(async ({ session, options }) => {
            const uid = session.userId
            const gid = session.guildId
            const name = getUsername(session)

            if (! gid && ! options.global) return '请在群内调用'

            const { data: members } = await session.bot.getGuildMemberList(gid)

            const today = + dayjs(new Date).startOf('day')
            const list = await ctx.database.get('w-jrrp-record', { day: today })
            const top = (await Promise
                .all(list.map(async ({ uid, rp }) => {
                    if (! options.global &&
                        ! members.some(member => member.user.id === uid)
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
                .slice(0, options.max || undefined)

            if (! top.length) return '今天还没有人测过人品哦'

            const rank = top.findIndex(rec => rec.uid === uid) + 1
            const rankMsg = rank ? `${name} 的今日人品排名是${options.reverse ? '倒数' : ''}第 ${rank}\n` : `${name} 今天还没有测过人品\n`

            if (! options.chart) return (
                rankMsg +
                `今日人品排行榜\n` +
                top
                    .map((rec, i) => `${rec.uid === uid ? '* ' : ''}${i + 1}. ${rec.name}: ${rec.rp}`)
                    .join('\n')
            )

            top.reverse() // ECharts 图表顺序从下向上

            const { chart, canvas } = createChart(ctx, 800, 500)
            chart.setOption({
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
                    data: top.map((rec, i) => ({
                        value: rec.rp,
                        itemStyle: rec.uid === uid ? { color: 'orange' } : undefined
                    })),
                    label: { show: true }
                },
                backgroundColor: '#fff'
            })

            return [
                h.text(rankMsg),
                h.image(canvas.toBuffer('image/png'), 'image/png')
            ]
        })

    ctx.command('jrrp.history', '查看我的人品历史')
        .option('chart', '-c', { fallback: true })
        .option('chart', '-C', { value: false })
        .action(async ({ session, options }) => {
            const uid = session.userId
            const recs = (await ctx.database
                .get('w-jrrp-record', { uid }))
                .sort((rec1, rec2) => rec1.day - rec2.day)

            if (! options.chart) return recs
                .map(({ day, rp }) => `${ dayjs(day).format('YYYY-MM-DD') }: ${rp}`)
                .join('\n') || '你还没有历史人品'

            const { chart, canvas } = createChart(ctx, 800, 500)

            chart.setOption({
                xAxis: {
                    type: 'category',
                    data: recs.map(({ day }) => dayjs(day).format('YYYY-MM-DD'))
                },
                yAxis: {
                    type: 'value',
                    name: '人品',
                    min: 0,
                    max: 100
                },
                series: {
                    type: 'line',
                    data: recs.map(({ rp }) => rp),
                    label: { show: true }
                },
                backgroundColor: '#fff'
            })

            return h.image(canvas.toBuffer('image/png'), 'image/png')
        })
}
