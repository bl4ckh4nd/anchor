package anchor

import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.focus.focusRequester
import androidx.compose.runtime.remember

internal val folderIcons = mapOf(
    NoteFolder.Notes to AnchorIcons.StickyNote,
    NoteFolder.Archive to AnchorIcons.Archive,
    NoteFolder.Trash to AnchorIcons.Trash2,
)

@Composable
internal fun AnchorBrand(modifier: Modifier = Modifier) {
    Row(
        modifier.height(40.dp).padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Box(
            Modifier.size(26.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.primary),
            contentAlignment = Alignment.Center,
        ) { Icon(AnchorIcons.Anchor, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onPrimary) }
        Text("Anchor", style = MaterialTheme.typography.titleMedium.copy(fontSize = 18.sp, fontWeight = FontWeight.Bold))
    }
}

@Composable
private fun DrawerRow(
    label: String,
    icon: ImageVector,
    count: Int?,
    current: Boolean,
    onClick: () -> Unit,
    compact: Boolean = false,
    iconTint: Color = Color.Unspecified,
) {
    val colors = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().height(if (compact) 40.dp else 44.dp).clip(RoundedCornerShape(8.dp))
            .then(if (current) Modifier.shadow(1.dp, RoundedCornerShape(8.dp)).background(colors.surfaceContainerLowest) else Modifier)
            .clickable(role = Role.Tab, onClick = onClick)
            // One announcement per row: the name, then the count as its state.
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Tab
                selected = current
                if (count != null) stateDescription = if (count == 1) "1 note" else "$count notes"
            }
            .padding(start = 12.dp, end = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(
            icon, null, Modifier.size(if (compact) 15.dp else 18.dp),
            tint = when {
                iconTint != Color.Unspecified -> iconTint
                current -> colors.tertiary
                else -> colors.onSurfaceVariant
            },
        )
        Text(
            label, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
            color = if (current) colors.onSurface else colors.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium.copy(
                fontSize = if (compact) 13.5.sp else 14.sp,
                fontWeight = if (current) FontWeight.SemiBold else FontWeight.Medium,
            ),
        )
        if (count != null) Text(
            count.toString(), color = colors.onSurfaceVariant,
            style = MaterialTheme.typography.labelMedium.copy(fontSize = 12.5.sp),
        )
    }
}

internal enum class SyncState { Synced, Syncing, Offline }

/** The web sidebar: new note, folders, tags, sync state and the account. */
@Composable
internal fun LibraryDrawer(
    folder: NoteFolder,
    tagFilter: String?,
    folderCounts: Map<NoteFolder, Int>,
    tags: List<CachedTag>,
    tagCounts: Map<String, Int>,
    sync: SyncState,
    accountName: String,
    accountDetail: String,
    accountColor: Color,
    onNewNote: () -> Unit,
    onFolder: (NoteFolder) -> Unit,
    onTag: (String) -> Unit,
    onSync: () -> Unit,
    onAccount: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxSize().padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 12.dp)) {
        AnchorBrand()
        AnchorButton(
            "New note", onNewNote, Modifier.fillMaxWidth().padding(vertical = 12.dp),
            icon = AnchorIcons.NotebookPen,
        )
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            for (item in NoteFolder.entries) {
                DrawerRow(
                    item.name, checkNotNull(folderIcons[item]), folderCounts[item],
                    current = folder == item && tagFilter == null, onClick = { onFolder(item) },
                )
            }
            if (tags.isNotEmpty()) {
                SectionLabel("Tags", Modifier.padding(start = 12.dp, top = 14.dp))
                for (tag in tags) {
                    DrawerRow(
                        tag.name, AnchorIcons.Hash, tagCounts[tag.id] ?: 0, current = tagFilter == tag.id,
                        onClick = { onTag(tag.id) }, compact = true,
                    )
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(vertical = 6.dp).clip(RoundedCornerShape(10.dp))
                .clickable(role = Role.Button, onClickLabel = "Sync notes", onClick = onSync)
                .semantics { contentDescription = "Sync notes" }
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(if (sync == SyncState.Offline) AnchorIcons.CloudOff else AnchorIcons.Cloud, null, Modifier.size(15.dp), tint = colors.onSurfaceVariant)
            Text(
                when (sync) {
                    SyncState.Synced -> "Synced"
                    SyncState.Syncing -> "Syncing…"
                    SyncState.Offline -> "Offline"
                },
                Modifier.weight(1f), color = colors.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp),
            )
            Box(
                Modifier.size(8.dp).clip(CircleShape).background(
                    when (sync) {
                        SyncState.Synced -> LocalAnchorTones.current.added
                        SyncState.Syncing -> colors.outline
                        SyncState.Offline -> LocalAnchorTones.current.onWarn
                    },
                ),
            )
        }
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                .clickable(role = Role.Button, onClick = onAccount)
                .clearAndSetSemantics {
                    contentDescription = "Account menu"
                    stateDescription = "$accountName, $accountDetail"
                    role = Role.Button
                }
                .padding(start = 6.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Avatar(initialsOf(accountName), accountColor)
            Column(Modifier.weight(1f)) {
                Text(accountName, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(accountDetail, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp), color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Icon(AnchorIcons.ChevronDown, null, Modifier.size(15.dp), tint = colors.onSurfaceVariant)
        }
    }
}

private enum class SortKey(val label: String, val icon: ImageVector) {
    Edited("Last edited", AnchorIcons.Pencil),
    Created("Date created", AnchorIcons.Calendar),
    Title("Title", AnchorIcons.ArrowDownAZ),
    Custom("Custom order", AnchorIcons.GripVertical),
}

private val NoteSort.key get() = when (this) {
    NoteSort.EditedNewest, NoteSort.EditedOldest -> SortKey.Edited
    NoteSort.CreatedNewest, NoteSort.CreatedOldest -> SortKey.Created
    NoteSort.TitleAscending, NoteSort.TitleDescending -> SortKey.Title
    NoteSort.Custom -> SortKey.Custom
}

private val NoteSort.reversed get() = this == NoteSort.EditedOldest || this == NoteSort.CreatedOldest || this == NoteSort.TitleDescending

private fun sortOf(key: SortKey, reversed: Boolean) = when (key) {
    SortKey.Edited -> if (reversed) NoteSort.EditedOldest else NoteSort.EditedNewest
    SortKey.Created -> if (reversed) NoteSort.CreatedOldest else NoteSort.CreatedNewest
    SortKey.Title -> if (reversed) NoteSort.TitleDescending else NoteSort.TitleAscending
    SortKey.Custom -> NoteSort.Custom
}

/** Layout and order of the library (frame F08). The seven orders are four criteria with a direction. */
@Composable
internal fun ViewOptionsSheet(
    layout: NoteLayout,
    sort: NoteSort,
    enabled: Boolean,
    onLayout: (NoteLayout) -> Unit,
    onSort: (NoteSort) -> Unit,
    onClose: () -> Unit,
) {
    AnchorSheet(onDismiss = onClose, title = "View options") {
        SectionLabel("Layout", Modifier.padding(top = 8.dp))
        Segmented(
            NoteLayout.entries, layout, { it.name }, onLayout, enabled = enabled,
            icon = {
                when (it) {
                    NoteLayout.List -> AnchorIcons.List
                    NoteLayout.Grid -> AnchorIcons.LayoutGrid
                    NoteLayout.Masonry -> AnchorIcons.LayoutDashboard
                }
            },
        )
        SectionLabel("Order", Modifier.padding(top = 12.dp))
        for (key in SortKey.entries) {
            MenuRow(
                key.label, icon = key.icon, selected = sort.key == key, enabled = enabled, role = Role.RadioButton,
                onClick = { onSort(sortOf(key, sort.reversed && sort.key != SortKey.Custom)) },
            )
        }
        if (sort.key != SortKey.Custom) {
            SectionLabel("Direction", Modifier.padding(top = 12.dp))
            val labels = if (sort.key == SortKey.Title) listOf("A to Z", "Z to A") else listOf("Newest first", "Oldest first")
            Segmented(listOf(false, true), sort.reversed, { if (it) labels[1] else labels[0] }, {
                onSort(sortOf(sort.key, it))
            }, enabled = enabled)
        } else {
            Text(
                "Custom order lets you drag notes.", Modifier.padding(top = 8.dp),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** The account menu (frame F05). */
@Composable
internal fun AccountSheet(
    name: String,
    detail: String,
    color: Color,
    server: String,
    appearance: AnchorAppearance?,
    sync: SyncState,
    enabled: Boolean,
    onAppearance: (AnchorAppearance) -> Unit,
    onSettings: () -> Unit,
    onTwoFactor: () -> Unit,
    onServerHeaders: () -> Unit,
    onSync: () -> Unit,
    onSignOut: () -> Unit,
    onClose: () -> Unit,
) {
    AnchorSheet(onDismiss = onClose) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainer)
                .padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Avatar(initialsOf(name), color)
            Column(Modifier.weight(1f)) {
                Text(name, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(server, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Box(Modifier.height(8.dp))
        MenuRow("Settings", onSettings, icon = AnchorIcons.Settings, enabled = enabled)
        MenuRow("Two-factor authentication", onTwoFactor, icon = AnchorIcons.ShieldCheck, enabled = enabled)
        MenuRow("Server headers", onServerHeaders, icon = AnchorIcons.Server, enabled = enabled)
        MenuRow(
            "Sync notes", onSync, icon = AnchorIcons.RefreshCw, enabled = enabled,
            detail = when (sync) {
                SyncState.Synced -> "Synced"
                SyncState.Syncing -> "Syncing…"
                SyncState.Offline -> "Offline"
            },
        )
        SectionLabel("Theme", Modifier.padding(top = 12.dp))
        Segmented(
            AnchorAppearance.entries, appearance, AnchorAppearance::label, onAppearance, enabled = appearance != null,
            icon = { themeIcon(it) },
        )
        MenuDivider()
        MenuRow("Sign out", onSignOut, icon = AnchorIcons.LogOut, danger = true, enabled = enabled)
    }
}

internal fun themeIcon(appearance: AnchorAppearance) = when (appearance) {
    AnchorAppearance.Light -> AnchorIcons.Sun
    AnchorAppearance.Dark -> AnchorIcons.Moon
    AnchorAppearance.System -> AnchorIcons.Monitor
}

internal class DockAction(val label: String, val description: String, val icon: ImageVector, val danger: Boolean = false, val onClick: () -> Unit)

/** Floating bar with the actions for selected notes (frames F13, F14). */
@Composable
internal fun SelectionDock(actions: List<DockAction>, enabled: Boolean, modifier: Modifier = Modifier) {
    Surface(
        modifier.widthIn(max = 560.dp).fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.inverseSurface,
        contentColor = MaterialTheme.colorScheme.inverseOnSurface,
        shadowElevation = 10.dp,
    ) {
        Row(Modifier.heightIn(min = 60.dp).padding(horizontal = 6.dp), horizontalArrangement = Arrangement.SpaceAround,
            verticalAlignment = Alignment.CenterVertically) {
            for (action in actions) {
                val ink = if (action.danger) MaterialTheme.colorScheme.inversePrimary else MaterialTheme.colorScheme.inverseOnSurface
                Column(
                    Modifier.weight(1f).clip(RoundedCornerShape(10.dp))
                        .clickable(enabled = enabled, role = Role.Button, onClick = action.onClick)
                        .clearAndSetSemantics {
                            contentDescription = action.description
                            role = Role.Button
                            if (!enabled) disabled()
                        }
                        .padding(vertical = 8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Icon(action.icon, null, Modifier.size(19.dp), tint = ink.copy(alpha = if (enabled) 1f else 0.5f))
                    Text(
                        action.label, color = ink.copy(alpha = if (enabled) 1f else 0.5f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp, fontWeight = FontWeight.Medium),
                    )
                }
            }
        }
    }
}

/** Header of the sign-in screens: brand, title and one line of context (frames F60–F66). */
@Composable
internal fun AuthHeader(title: String, subtitle: String?) {
    AnchorBrand(Modifier.padding(bottom = 16.dp))
    Text(
        title, Modifier.semantics { heading() },
        style = MaterialTheme.typography.headlineSmall.copy(fontSize = 25.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.5).sp),
    )
    if (subtitle != null) Text(
        subtitle, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** Launch screen while the saved session is restored (frame F67). */
@Composable
internal fun LaunchScreen() {
    Column(
        Modifier.fillMaxSize().semantics(mergeDescendants = true) { contentDescription = "Opening Anchor" },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier.size(56.dp).clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.primary),
            contentAlignment = Alignment.Center,
        ) { Icon(AnchorIcons.Anchor, null, Modifier.size(28.dp), tint = MaterialTheme.colorScheme.onPrimary) }
        Text("Anchor", Modifier.padding(top = 12.dp), style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold))
        CircularProgressIndicator(Modifier.padding(top = 24.dp).size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** The search field that replaces the top bar title while searching (frame F07). */
@Composable
internal fun SearchField(value: String, onValueChange: (String) -> Unit, modifier: Modifier = Modifier) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(focus) { focus.requestFocus() }
    val colors = MaterialTheme.colorScheme
    val style = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp)
    BasicTextField(
        value, onValueChange,
        modifier.focusRequester(focus).semantics { contentDescription = "Search notes" },
        singleLine = true,
        textStyle = style.copy(color = colors.onSurface),
        cursorBrush = SolidColor(colors.tertiary),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        decorationBox = { field ->
            Row(
                Modifier.height(44.dp).clip(ControlShape).background(colors.surface).padding(start = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(AnchorIcons.Search, null, Modifier.size(16.dp), tint = colors.onSurfaceVariant)
                Box(Modifier.weight(1f)) {
                    if (value.isEmpty()) Text("Search notes", style = style, color = colors.onSurfaceVariant)
                    field()
                }
                if (value.isNotEmpty()) AnchorIconButton(AnchorIcons.X, "Clear search", { onValueChange("") })
            }
        },
    )
}

/** A note saved on this device that has not reached the server yet. */
@Composable
internal fun PendingNoteCard(draft: PendingNote, readable: Boolean, onReview: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val review = draft.rejected || !readable
    val title = draft.title.ifBlank { "Untitled note" }
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(colors.surface)
            .then(if (review) Modifier.clickable(role = Role.Button, onClick = onReview) else Modifier)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(
            if (review) AnchorIcons.TriangleAlert else AnchorIcons.Clock, null, Modifier.size(18.dp),
            tint = if (review) LocalAnchorTones.current.onWarn else colors.onSurfaceVariant,
        )
        Column(Modifier.weight(1f)) {
            Text(
                when {
                    !readable -> "Draft unavailable"
                    draft.rejected -> "$title (needs review)"
                    else -> title
                },
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(
                if (review) "Tap to review" else "Waiting to send",
                style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant,
            )
        }
        if (review) Icon(AnchorIcons.ChevronRight, null, Modifier.size(16.dp), tint = colors.onSurfaceVariant)
    }
}

/** Android system back for in-app screens; iOS has no system back here. */
@Composable
internal expect fun SystemBackHandler(enabled: Boolean, onBack: () -> Unit)
