package io.amar.console.data.chat

import java.util.Calendar

/**
 * Snooze target times — port of the SPA's getSnoozeTime (src/utils/date.ts).
 * All relative to [now] (injectable for tests).
 */
object SnoozeTimes {

    /** 3 hours from now, or 6pm today, whichever is later. */
    fun laterToday(now: Long = System.currentTimeMillis()): Long {
        val threeHours = now + 3 * 3600_000L
        val sixPm = Calendar.getInstance().apply {
            timeInMillis = now
            set(Calendar.HOUR_OF_DAY, 18); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis
        return maxOf(threeHours, sixPm)
    }

    /** Tomorrow 8:00. */
    fun tomorrowMorning(now: Long = System.currentTimeMillis()): Long =
        Calendar.getInstance().apply {
            timeInMillis = now
            add(Calendar.DAY_OF_YEAR, 1)
            set(Calendar.HOUR_OF_DAY, 8); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis

    /** Next Monday 8:00 (always strictly in the future, even on a Monday). */
    fun nextWeekMonday(now: Long = System.currentTimeMillis()): Long =
        Calendar.getInstance().apply {
            timeInMillis = now
            val day = get(Calendar.DAY_OF_WEEK) // SUNDAY=1 … SATURDAY=7
            // Days until next Monday, minimum 7 when today IS Monday (SPA parity).
            val daysUntil = ((Calendar.MONDAY - day) + 7) % 7
            add(Calendar.DAY_OF_YEAR, if (daysUntil == 0) 7 else daysUntil)
            set(Calendar.HOUR_OF_DAY, 8); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis
}
