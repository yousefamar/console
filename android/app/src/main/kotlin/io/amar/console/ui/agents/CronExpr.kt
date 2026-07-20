package io.amar.console.ui.agents

import java.util.Calendar
import java.util.TimeZone

/**
 * Minimal 5-field cron evaluator (min hour dom month dow) for the CronPanel's
 * "next in Xs/m/h/d" preview + the create-form's next-3-fires preview. Pure +
 * unit-tested. Local time (matches the hub's local-time cron interpretation).
 *
 * Supports: `*`, `N`, `A-B` ranges, `A,B,C` lists, `* / step` and `A-B/step`.
 * Day-of-month vs day-of-week use cron's OR semantics when both are restricted.
 */
object CronExpr {

    class ParseException(msg: String) : Exception(msg)

    private data class Field(val allowed: Set<Int>, val restricted: Boolean)

    private fun parseField(spec: String, min: Int, max: Int): Field {
        if (spec == "*") return Field((min..max).toSet(), restricted = false)
        val out = sortedSetOf<Int>()
        for (part in spec.split(",")) {
            val (rangePart, stepPart) = if (part.contains("/")) part.substringBefore("/") to part.substringAfter("/") else part to null
            val step = stepPart?.toIntOrNull() ?: 1
            if (step <= 0) throw ParseException("bad step in '$part'")
            val (lo, hi) = when {
                rangePart == "*" -> min to max
                rangePart.contains("-") -> {
                    val a = rangePart.substringBefore("-").toIntOrNull() ?: throw ParseException("bad range '$part'")
                    val b = rangePart.substringAfter("-").toIntOrNull() ?: throw ParseException("bad range '$part'")
                    a to b
                }
                else -> {
                    val v = rangePart.toIntOrNull() ?: throw ParseException("bad value '$part'")
                    v to v
                }
            }
            if (lo < min || hi > max || lo > hi) throw ParseException("out of range '$part'")
            var v = lo
            while (v <= hi) { out.add(v); v += step }
        }
        return Field(out, restricted = true)
    }

    private class Parsed(
        val min: Field, val hour: Field, val dom: Field, val month: Field, val dow: Field,
    )

    private fun parse(expr: String): Parsed {
        val f = expr.trim().split(Regex("\\s+"))
        if (f.size != 5) throw ParseException("expected 5 fields, got ${f.size}")
        return Parsed(
            parseField(f[0], 0, 59),
            parseField(f[1], 0, 23),
            parseField(f[2], 1, 31),
            parseField(f[3], 1, 12),
            parseField(f[4], 0, 7), // 0 and 7 = Sunday
        )
    }

    /** Next [count] fire times strictly after [afterMs] (local tz). Empty if
     *  none within a ~2-year search window. Throws [ParseException] on a bad expr. */
    fun nextRuns(expr: String, afterMs: Long, count: Int, tz: TimeZone = TimeZone.getDefault()): List<Long> {
        val p = parse(expr)
        val out = mutableListOf<Long>()
        val cal = Calendar.getInstance(tz)
        cal.timeInMillis = afterMs
        cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
        cal.add(Calendar.MINUTE, 1) // strictly after
        var guard = 0
        val maxIterations = 366 * 24 * 60 * 2 // ~2yr of minutes
        while (out.size < count && guard++ < maxIterations) {
            val minute = cal.get(Calendar.MINUTE)
            val hour = cal.get(Calendar.HOUR_OF_DAY)
            val dom = cal.get(Calendar.DAY_OF_MONTH)
            val month = cal.get(Calendar.MONTH) + 1
            // Calendar.SUNDAY=1..SATURDAY=7 → cron 0..6 (Sun=0)
            val dowRaw = cal.get(Calendar.DAY_OF_WEEK) - 1 // 0=Sun..6=Sat
            val dowMatch = p.dow.allowed.contains(dowRaw) || (dowRaw == 0 && p.dow.allowed.contains(7))
            val domMatch = p.dom.allowed.contains(dom)
            val dayMatch = when {
                p.dom.restricted && p.dow.restricted -> domMatch || dowMatch
                p.dom.restricted -> domMatch
                p.dow.restricted -> dowMatch
                else -> true
            }
            if (p.min.allowed.contains(minute) && p.hour.allowed.contains(hour) && p.month.allowed.contains(month) && dayMatch) {
                out.add(cal.timeInMillis)
            }
            cal.add(Calendar.MINUTE, 1)
        }
        return out
    }

    /** True when [expr] is a valid 5-field cron. */
    fun isValid(expr: String): Boolean = runCatching { parse(expr) }.isSuccess
}
