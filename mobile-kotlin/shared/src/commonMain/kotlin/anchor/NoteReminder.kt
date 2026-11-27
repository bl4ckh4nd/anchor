package anchor

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDefaults
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimeInput
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TimePickerDialog
import androidx.compose.material3.TimePickerDefaults
import androidx.compose.material3.TimePickerDialogDefaults
import androidx.compose.material3.TimePickerDisplayMode
import androidx.compose.material3.TimePickerSelectionMode
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Instant

/** The device's current local wall clock as `YYYY-MM-DDTHH:mm`. */
internal expect fun reminderNow(): String

internal data class ReminderNotifications(val disabled: Boolean, val openSettings: () -> Unit)

@Composable
internal expect fun reminderNotifications(): ReminderNotifications

// Reminders are floating wall-clock times; this arithmetic treats them as UTC so no zone shifts them.
private fun wallClock(value: String) = Instant.parse("$value:00Z")
private fun wallClockText(at: Instant) = at.toString().take(16)

/** Quick choices of the web reminder picker: label and wall-clock time, for a `YYYY-MM-DDTHH:mm` now. */
internal fun reminderPresets(now: String): List<Pair<String, String>> {
    val step = 5.minutes.inWholeMilliseconds
    val later = wallClockText(Instant.fromEpochMilliseconds(((wallClock(now) + 3.hours).toEpochMilliseconds() + step - 1) / step * step))
    val day = now.take(10)
    fun nineOClock(after: Int) = wallClockText(wallClock("${day}T09:00") + after.days)
    return listOfNotNull(
        ("Later today" to later).takeIf { later.startsWith(day) },
        "Tomorrow" to nineOClock(1),
        "Next week" to nineOClock(7),
    )
}

private val weekdays = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
private val months = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** `Fri, Nov 28`, as the web picker formats days, with the year when it is not the current one. */
internal fun reminderDayLabel(date: String, today: String): String? = runCatching {
    val day = wallClock("${date}T00:00").epochSeconds / 86_400
    val (year, month, dayOfMonth) = date.split('-').map { it.toInt() }
    val label = "${weekdays[(day + 4).mod(7)]}, ${months[month - 1]} $dayOfMonth"
    if (date.take(4) == today.take(4)) label else "$label, $year"
}.getOrNull()

internal fun reminderTimeLabel(hour: Int, minute: Int, is24Hour: Boolean): String {
    val minutes = minute.toString().padStart(2, '0')
    if (is24Hour) return "${hour.toString().padStart(2, '0')}:$minutes"
    return "${(hour + 11) % 12 + 1}:$minutes ${if (hour < 12) "AM" else "PM"}"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun NoteReminder(
    note: CachedNote,
    busy: Boolean,
    message: String,
    onClose: () -> Unit,
    onUpdate: (CachedNote, String?, ReminderRepeat, () -> Unit) -> Unit,
) {
    val snapshot = remember { note }
    val now = remember { reminderNow() }
    val presets = remember { reminderPresets(now) }
    // A new reminder starts on the first quick choice; nothing is stored until Save.
    val initial = snapshot.remindAt ?: presets.first().second
    var date by remember { mutableStateOf(initial.substringBefore('T')) }
    var time by remember { mutableStateOf(initial.substringAfter('T', "")) }
    var repeat by remember {
        mutableStateOf(ReminderRepeat.entries.firstOrNull { it.wire == snapshot.reminderRecurrence } ?: ReminderRepeat.None)
    }
    var showRepeats by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf<String?>(null) }
    val clock = rememberTimePickerState()
    val notifications = reminderNotifications()
    var clockMode by remember { mutableStateOf(TimePickerDisplayMode.Picker) }
    val at = reminderWallClock(date, time)
    val hour = time.substringBefore(':').toIntOrNull()?.takeIf { it in 0..23 }
    val minute = time.substringAfter(':', "").toIntOrNull()?.takeIf { it in 0..59 }
    val timeText = if (hour != null && minute != null) reminderTimeLabel(hour, minute, clock.is24hour) else null
    AnchorSheet(
        onDismiss = { if (!busy) onClose() },
        title = if (snapshot.remindAt == null) "Set reminder" else "Edit reminder",
    ) {
        if (notifications.disabled) AnchorBanner(
            "Notifications are off for Anchor. Reminders sync, but this device won’t alert you.",
            icon = AnchorIcons.BellOff,
        )
        if (snapshot.remindAt == null) FlowRow(
            Modifier.padding(top = 2.dp).selectableGroup(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            for ((label, value) in presets) {
                val text = if (label == "Tomorrow") "$label ${reminderTimeLabel(9, 0, clock.is24hour)}" else label
                QuickChoice(text, value == "${date}T$time", !busy) {
                    date = value.substringBefore('T')
                    time = value.substringAfter('T')
                }
            }
        }
        PickerField("Date", reminderDayLabel(date, now) ?: "Select a date", AnchorIcons.Calendar, !busy) {
            picking = "date"
        }
        PickerField("Time", timeText ?: "Select a time", AnchorIcons.Clock, !busy) {
            clock.hour = hour ?: 9
            clock.minute = minute ?: 0
            clock.selection = TimePickerSelectionMode.Hour
            clockMode = TimePickerDisplayMode.Picker
            picking = "time"
        }
        Box {
            PickerField("Repeat", repeat.label, null, !busy, trailing = AnchorIcons.ChevronDown) { showRepeats = true }
            DropdownMenu(expanded = showRepeats, onDismissRequest = { showRepeats = false }) {
                for (item in ReminderRepeat.entries) {
                    DropdownMenuItem(text = { Text(item.label) }, onClick = {
                        repeat = item
                        showRepeats = false
                    })
                }
            }
        }
        if (snapshot.remindAt != null) {
            TextButton(
                enabled = !busy, contentPadding = PaddingValues(horizontal = 0.dp), modifier = Modifier.padding(top = 6.dp),
                onClick = { onUpdate(snapshot, null, ReminderRepeat.None, onClose) },
            ) {
                Icon(AnchorIcons.BellOff, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.error)
                Text("Remove reminder", Modifier.padding(start = 8.dp), color = MaterialTheme.colorScheme.error)
            }
        }
        if (message.isNotEmpty()) AnchorBanner(message, Modifier.padding(top = 4.dp), BannerTone.Error)
        Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            AnchorButton(
                if (notifications.disabled) "Open settings" else "Cancel",
                if (notifications.disabled) notifications.openSettings else onClose,
                Modifier.weight(1f), ButtonTone.Secondary, !busy,
            )
            AnchorButton("Save reminder", { onUpdate(snapshot, at, repeat, onClose) }, Modifier.weight(1f), enabled = !busy && at != null)
        }
    }
    when (picking) {
        "date" -> {
            val selected = runCatching { wallClock("${date}T00:00").toEpochMilliseconds() }.getOrNull()
            val year = date.take(4).toIntOrNull() ?: now.take(4).toInt()
            val range = DatePickerDefaults.YearRange
            val state = rememberDatePickerState(
                initialSelectedDateMillis = selected,
                yearRange = minOf(range.first, year)..maxOf(range.last, year),
            )
            DatePickerDialog(
                onDismissRequest = { picking = null },
                confirmButton = {
                    TextButton(enabled = state.selectedDateMillis != null, onClick = {
                        // The picker reports UTC midnight of the chosen day.
                        state.selectedDateMillis?.let { date = Instant.fromEpochMilliseconds(it).toString().take(10) }
                        picking = null
                    }) { Text("OK") }
                },
                dismissButton = { TextButton(onClick = { picking = null }) { Text("Cancel") } },
            ) { DatePicker(state) }
        }
        "time" -> TimePickerDialog(
            onDismissRequest = { picking = null },
            confirmButton = {
                TextButton(onClick = {
                    time = "${clock.hour.toString().padStart(2, '0')}:${clock.minute.toString().padStart(2, '0')}"
                    picking = null
                }) { Text("OK") }
            },
            title = { TimePickerDialogDefaults.Title(clockMode) },
            dismissButton = { TextButton(onClick = { picking = null }) { Text("Cancel") } },
            modeToggleButton = {
                val inputMode = clockMode == TimePickerDisplayMode.Input
                AnchorIconButton(
                    if (inputMode) AnchorIcons.Clock else AnchorIcons.Pencil,
                    if (inputMode) "Switch to clock mode for the time input" else "Switch to text input mode for the time input",
                    onClick = { clockMode = if (inputMode) TimePickerDisplayMode.Picker else TimePickerDisplayMode.Input },
                )
            },
        ) {
            // The theme leaves Material's container roles unset; map the dial onto the app's tones.
            val colors = MaterialTheme.colorScheme
            val clockColors = TimePickerDefaults.colors(
                clockDialColor = colors.surfaceContainer,
                periodSelectorBorderColor = colors.outline,
                periodSelectorSelectedContainerColor = colors.secondaryContainer,
                periodSelectorSelectedContentColor = colors.onSecondaryContainer,
                periodSelectorUnselectedContentColor = colors.onSurfaceVariant,
                timeSelectorSelectedContainerColor = colors.secondaryContainer,
                timeSelectorSelectedContentColor = colors.onSecondaryContainer,
                timeSelectorUnselectedContainerColor = colors.surfaceContainer,
                timeSelectorUnselectedContentColor = colors.onSurface,
            )
            if (clockMode == TimePickerDisplayMode.Picker) TimePicker(clock, colors = clockColors) else TimeInput(clock, colors = clockColors)
        }
    }
}

/** A field that opens a picker: looks like [AnchorField], is announced by its label and shows the value. */
@Composable
private fun PickerField(
    label: String,
    value: String,
    icon: ImageVector?,
    enabled: Boolean,
    trailing: ImageVector? = null,
    onClick: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            label, Modifier.clearAndSetSemantics {},
            style = MaterialTheme.typography.labelLarge.copy(fontSize = 13.5.sp, fontWeight = FontWeight.Medium),
        )
        Row(
            Modifier.fillMaxWidth().heightIn(min = 52.dp).clip(ControlShape).background(colors.surface)
                .border(1.dp, colors.outline, ControlShape)
                .semantics { contentDescription = label }
                .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val alpha = if (enabled) 1f else 0.45f
            if (icon != null) Icon(icon, null, Modifier.size(18.dp), tint = colors.onSurfaceVariant.copy(alpha = alpha))
            Text(value, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge.copy(fontSize = 16.sp), color = colors.onSurface.copy(alpha = alpha))
            if (trailing != null) Icon(trailing, null, Modifier.size(18.dp), tint = colors.onSurfaceVariant.copy(alpha = alpha))
        }
    }
}

/** A quick-choice pill of the frames (`.chip.lg`): filled when it matches the chosen time. */
@Composable
private fun QuickChoice(text: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Box(
        Modifier.minimumInteractiveComponentSize()
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier.height(32.dp).clip(CircleShape)
                .background(if (selected) colors.onSurface else Color.Transparent)
                .then(if (selected) Modifier else Modifier.border(1.dp, colors.outlineVariant, CircleShape))
                .padding(horizontal = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text, color = if (selected) colors.surface else colors.onSurface,
                style = MaterialTheme.typography.labelLarge.copy(fontSize = 12.5.sp, fontWeight = FontWeight.Medium),
            )
        }
    }
}

internal fun reminderLabel(note: CachedNote): String? = note.remindAt?.let {
    val repeat = ReminderRepeat.entries.firstOrNull { item -> item.wire == note.reminderRecurrence }
    listOfNotNull(it.replace('T', ' '), repeat?.takeUnless { item -> item == ReminderRepeat.None }?.label).joinToString(" · ")
}
