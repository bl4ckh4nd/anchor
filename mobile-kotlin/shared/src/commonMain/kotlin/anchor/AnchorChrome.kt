package anchor

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.BasicAlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Shared pieces of the mobile design. Sizes follow the approved OpenFrame frames,
// colours come from the theme (web/app/styles/tokens.css).

internal val ControlShape = RoundedCornerShape(10.dp)
internal val SheetShape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)

@Composable
internal fun AnchorIconButton(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    selected: Boolean = false,
    tint: Color = Color.Unspecified,
) {
    IconButton(
        onClick = onClick,
        modifier = modifier.size(44.dp),
        enabled = enabled,
        shape = ControlShape,
        colors = IconButtonDefaults.iconButtonColors(
            containerColor = if (selected) MaterialTheme.colorScheme.surfaceContainer else Color.Transparent,
            contentColor = if (tint == Color.Unspecified) LocalContentColor.current else tint,
        ),
    ) {
        Icon(icon, label, Modifier.size(20.dp))
    }
}

@Composable
internal fun AnchorTopBar(
    title: String?,
    modifier: Modifier = Modifier,
    count: Int? = null,
    navigation: (@Composable () -> Unit)? = null,
    compactTitle: Boolean = false,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        navigation?.invoke()
        Row(
            Modifier.weight(1f).padding(start = 6.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (title != null) Text(
                title,
                Modifier.weight(1f, fill = false).semantics { heading() },
                style = MaterialTheme.typography.titleLarge.copy(
                    fontSize = if (compactTitle) 17.sp else 21.sp,
                    fontWeight = if (compactTitle) FontWeight.SemiBold else FontWeight.Bold,
                    letterSpacing = (-0.46).sp,
                ),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (count != null) Text(
                count.toString(),
                Modifier.padding(bottom = 3.dp),
                style = MaterialTheme.typography.labelLarge.copy(fontSize = 13.sp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        actions()
    }
}

/** Uppercase section label, as the web uses above note groups and in sheets. */
@Composable
internal fun SectionLabel(text: String, modifier: Modifier = Modifier, count: Int? = null) {
    Row(
        // Spoken in its written case; the uppercase is only visual, as in the web's CSS.
        modifier.heightIn(min = 28.dp).clearAndSetSemantics {
            contentDescription = text
            heading()
        },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text.uppercase(),
            style = MaterialTheme.typography.labelMedium.copy(
                fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.72.sp,
            ),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (count != null) Text(
            count.toString(),
            style = MaterialTheme.typography.labelMedium.copy(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

internal enum class ButtonTone { Primary, Secondary, Danger, Ghost }

@Composable
internal fun AnchorButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tone: ButtonTone = ButtonTone.Primary,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    small: Boolean = false,
) {
    val colors = MaterialTheme.colorScheme
    val (container, content) = when (tone) {
        ButtonTone.Primary -> colors.primary to colors.onPrimary
        ButtonTone.Secondary -> colors.surface to colors.onSurface
        ButtonTone.Danger -> colors.error to colors.onError
        ButtonTone.Ghost -> Color.Transparent to colors.onSurface
    }
    Button(
        onClick = onClick,
        modifier = modifier.heightIn(min = if (small) 38.dp else 48.dp),
        enabled = enabled,
        shape = ControlShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = container,
            contentColor = content,
            disabledContainerColor = container.copy(alpha = if (tone == ButtonTone.Ghost) 0f else 0.45f),
            disabledContentColor = content.copy(alpha = 0.7f),
        ),
        border = if (tone == ButtonTone.Secondary) BorderStroke(1.dp, colors.outlineVariant) else null,
        contentPadding = PaddingValues(horizontal = if (small) 14.dp else 18.dp),
    ) {
        if (icon != null) {
            Icon(icon, null, Modifier.size(18.dp))
            Box(Modifier.width(8.dp))
        }
        Text(
            text,
            style = MaterialTheme.typography.labelLarge.copy(
                fontSize = if (small) 13.5.sp else 15.sp, fontWeight = FontWeight.SemiBold,
            ),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
internal fun AnchorField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    placeholder: String? = null,
    hint: String? = null,
    error: String? = null,
    enabled: Boolean = true,
    readOnly: Boolean = false,
    password: Boolean = false,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    visualTransformation: VisualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
    trailing: (@Composable () -> Unit)? = null,
) {
    val colors = MaterialTheme.colorScheme
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        // The field itself carries the label, so it is announced once.
        Text(
            label, Modifier.clearAndSetSemantics {},
            style = MaterialTheme.typography.labelLarge.copy(fontSize = 13.5.sp, fontWeight = FontWeight.Medium),
        )
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth().semantics { contentDescription = label },
            enabled = enabled,
            readOnly = readOnly,
            singleLine = true,
            isError = error != null,
            placeholder = placeholder?.let { { Text(it) } },
            leadingIcon = icon?.let { { Icon(it, null, Modifier.size(18.dp)) } },
            trailingIcon = trailing,
            visualTransformation = visualTransformation,
            keyboardOptions = keyboardOptions,
            shape = ControlShape,
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = colors.tertiary,
                unfocusedBorderColor = colors.outline,
                focusedContainerColor = colors.surface,
                unfocusedContainerColor = colors.surface,
                disabledContainerColor = colors.surface,
                unfocusedLeadingIconColor = colors.onSurfaceVariant,
                focusedLeadingIconColor = colors.onSurfaceVariant,
                cursorColor = colors.tertiary,
            ),
        )
        when {
            error != null -> Row(
                Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(AnchorIcons.TriangleAlert, null, Modifier.size(14.dp), tint = colors.error)
                Text(error, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp), color = colors.error)
            }
            hint != null -> Text(
                hint, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp), color = colors.onSurfaceVariant,
            )
        }
    }
}

internal enum class BannerTone { Info, Warning, Error }

@Composable
internal fun AnchorBanner(
    text: String,
    modifier: Modifier = Modifier,
    tone: BannerTone = BannerTone.Warning,
    icon: ImageVector = when (tone) {
        BannerTone.Info -> AnchorIcons.Info
        BannerTone.Warning -> AnchorIcons.TriangleAlert
        BannerTone.Error -> AnchorIcons.CircleAlert
    },
    actionLabel: String? = null,
    onAction: () -> Unit = {},
) {
    val colors = MaterialTheme.colorScheme
    val tones = LocalAnchorTones.current
    val (fill, ink) = when (tone) {
        BannerTone.Info -> colors.surfaceContainer to colors.onSurface
        BannerTone.Warning -> tones.warn to tones.onWarn
        BannerTone.Error -> colors.error.copy(alpha = 0.12f) to colors.error
    }
    Row(
        modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(fill)
            .padding(horizontal = 14.dp, vertical = 12.dp)
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(icon, null, Modifier.padding(top = 1.dp).size(17.dp), tint = ink)
        Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.5.sp), color = ink)
        if (actionLabel != null) TextButton(onClick = onAction, contentPadding = PaddingValues(horizontal = 8.dp)) {
            Text(actionLabel, color = ink, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
internal fun EmptyState(icon: ImageVector, title: String, text: String? = null, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxWidth().padding(horizontal = 28.dp, vertical = 64.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier.padding(bottom = 8.dp).size(88.dp).clip(RoundedCornerShape(28.dp))
                .background(MaterialTheme.colorScheme.surfaceContainer),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, null, Modifier.size(38.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(
            title, textAlign = TextAlign.Center,
            style = MaterialTheme.typography.titleMedium.copy(fontSize = 18.sp, fontWeight = FontWeight.Bold),
        )
        if (text != null) Text(
            text, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** One row of a sheet menu or settings list (the frames' `.mi` row). */
@Composable
internal fun MenuRow(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    detail: String? = null,
    selected: Boolean = false,
    danger: Boolean = false,
    enabled: Boolean = true,
    chevron: Boolean = false,
    role: Role = Role.Button,
) {
    val colors = MaterialTheme.colorScheme
    val ink = if (danger) colors.error else colors.onSurface
    Row(
        modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(8.dp))
            .background(if (selected) colors.surfaceContainer else Color.Transparent)
            .then(
                if (role == Role.RadioButton) Modifier.selectable(selected = selected, enabled = enabled, role = role, onClick = onClick)
                else Modifier.clickable(enabled = enabled, role = role, onClick = onClick),
            )
            .padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        val alpha = if (enabled) 1f else 0.45f
        if (icon != null) Icon(
            icon, null, Modifier.size(19.dp),
            tint = (if (danger) colors.error else if (selected) colors.tertiary else colors.onSurfaceVariant).copy(alpha = alpha),
        )
        Text(
            label, Modifier.weight(1f),
            style = MaterialTheme.typography.bodyLarge.copy(
                fontSize = 15.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            ),
            color = ink.copy(alpha = alpha),
        )
        if (detail != null) Text(
            detail, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp),
            color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        if (selected && role == Role.RadioButton) Icon(AnchorIcons.Check, null, Modifier.size(18.dp), tint = colors.tertiary)
        if (chevron) Icon(AnchorIcons.ChevronRight, null, Modifier.size(16.dp), tint = colors.onSurfaceVariant)
    }
}

@Composable
internal fun MenuDivider() {
    Box(Modifier.fillMaxWidth().padding(vertical = 4.dp).height(1.dp).background(LocalAnchorTones.current.divider))
}

/** The segmented control of the frames (`.seg`). */
@Composable
internal fun <T> Segmented(
    options: List<T>,
    selected: T?,
    label: (T) -> String,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: ((T) -> ImageVector?)? = null,
) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.surfaceContainer).padding(3.dp)
            .selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        for (option in options) {
            val on = option == selected
            Row(
                Modifier.weight(1f).height(38.dp).clip(RoundedCornerShape(9.dp))
                    .background(if (on) colors.surface else Color.Transparent)
                    .selectable(selected = on, enabled = enabled, role = Role.Tab, onClick = { onSelect(option) }),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val ink = (if (on) colors.onSurface else colors.onSurfaceVariant).copy(alpha = if (enabled) 1f else 0.45f)
                icon?.invoke(option)?.let { Icon(it, null, Modifier.padding(end = 6.dp).size(16.dp), tint = ink) }
                Text(
                    label(option), color = ink, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.labelLarge.copy(
                        fontSize = 13.5.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium,
                    ),
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AnchorSheet(
    onDismiss: () -> Unit,
    title: String? = null,
    subtitle: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        sheetMaxWidth = 640.dp,
        shape = SheetShape,
        containerColor = MaterialTheme.colorScheme.surface,
        contentColor = MaterialTheme.colorScheme.onSurface,
        scrimColor = MaterialTheme.colorScheme.scrim,
        dragHandle = {
            Box(
                Modifier.padding(top = 10.dp, bottom = 10.dp).size(36.dp, 4.dp).clip(CircleShape)
                    .background(MaterialTheme.colorScheme.outlineVariant),
            )
        },
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                .padding(start = 16.dp, end = 16.dp, bottom = 24.dp).navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (title != null) SheetTitle(title, subtitle)
            content()
        }
    }
}

@Composable
internal fun SheetTitle(title: String, subtitle: String? = null) {
    Text(
        title, Modifier.semantics { heading() },
        style = MaterialTheme.typography.titleLarge.copy(fontSize = 20.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.3).sp),
    )
    if (subtitle != null) Text(
        subtitle, Modifier.padding(top = 2.dp, bottom = 6.dp),
        style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp), color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** Confirmation dialog: title, short consequence, Cancel and the action side by side. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConfirmDialog(
    title: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    text: String? = null,
    destructive: Boolean = true,
    enabled: Boolean = true,
    dismissLabel: String = "Cancel",
    confirmEnabled: Boolean = enabled,
    content: (@Composable ColumnScope.() -> Unit)? = null,
) {
    BasicAlertDialog(onDismissRequest = { if (enabled) onDismiss() }) {
        Surface(
            Modifier.widthIn(max = 420.dp).fillMaxWidth(),
            shape = RoundedCornerShape(20.dp),
            color = MaterialTheme.colorScheme.surface,
            shadowElevation = 12.dp,
        ) {
            Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 22.dp, bottom = 18.dp)) {
                SheetTitle(title, text)
                content?.invoke(this)
                Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    AnchorButton(dismissLabel, onDismiss, Modifier.weight(1f).heightIn(min = 48.dp), ButtonTone.Secondary, enabled, small = true)
                    AnchorButton(
                        confirmLabel, onConfirm, Modifier.weight(1f).heightIn(min = 48.dp),
                        if (destructive) ButtonTone.Danger else ButtonTone.Primary, confirmEnabled, small = true,
                    )
                }
            }
        }
    }
}

/** Short status line at the bottom of a screen (the web's toast). */
@Composable
internal fun AnchorToast(
    text: String,
    modifier: Modifier = Modifier,
    actionLabel: String? = null,
    onAction: () -> Unit = {},
) {
    Surface(
        modifier.widthIn(max = 560.dp).fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.inverseSurface,
        contentColor = MaterialTheme.colorScheme.inverseOnSurface,
        shadowElevation = 8.dp,
    ) {
        Row(
            Modifier.heightIn(min = 48.dp).padding(start = 16.dp, end = 8.dp)
                .semantics { liveRegion = LiveRegionMode.Polite },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(text, Modifier.weight(1f).padding(vertical = 12.dp), style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp))
            if (actionLabel != null) TextButton(onClick = onAction) {
                Text(actionLabel, color = MaterialTheme.colorScheme.inversePrimary, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/** Placeholder card while the first notebook snapshot loads. */
@Composable
internal fun SkeletonCard(lines: Int = 2) {
    val colors = MaterialTheme.colorScheme
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(colors.surface).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        for (width in listOf(0.4f, 0.9f, 0.7f).take(lines + 1)) {
            Box(Modifier.fillMaxWidth(width).height(11.dp).clip(RoundedCornerShape(6.dp)).background(colors.surfaceContainer))
        }
    }
}

@Composable
internal fun Avatar(initials: String, color: Color, size: androidx.compose.ui.unit.Dp = 32.dp) {
    Box(Modifier.size(size).clip(CircleShape).background(color), contentAlignment = Alignment.Center) {
        Text(
            initials.uppercase(), color = Color.White,
            style = MaterialTheme.typography.labelLarge.copy(fontSize = (size.value * 0.4f).sp, fontWeight = FontWeight.SemiBold),
        )
    }
}

/** A full-screen surface with a back arrow, used for settings pages and other stacked screens. */
@Composable
internal fun StackedScreen(
    title: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    backLabel: String = "Back",
    backEnabled: Boolean = true,
    actions: @Composable RowScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(modifier.fillMaxSize()) {
        AnchorTopBar(
            title, navigation = { AnchorIconButton(AnchorIcons.ArrowLeft, backLabel, onBack, enabled = backEnabled) },
            compactTitle = true,
            actions = actions,
        )
        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.TopCenter) {
            Column(
                Modifier.widthIn(max = 640.dp).fillMaxWidth().verticalScroll(rememberScrollState())
                    .padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 32.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                content = content,
            )
        }
    }
}

/** A white rounded group of rows, as in the settings frames. */
@Composable
internal fun SettingsGroup(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        content = content,
    )
}

internal fun initialsOf(text: String): String {
    val words = text.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    return when (words.size) {
        0 -> "?"
        1 -> words.first().take(1)
        else -> words.first().take(1) + words.last().take(1)
    }
}

internal val avatarColors = listOf(
    Color(0xFFA4522A), Color(0xFF3F6FA6), Color(0xFF8A4FA3), Color(0xFF2F7D6D),
    Color(0xFF6A6F2A), Color(0xFF7A4B2F), Color(0xFFA13F5C), Color(0xFF3B5F8A),
    Color(0xFF9A5B16), Color(0xFF4D5C9E), Color(0xFF556B2F),
)

internal fun avatarColor(userId: String): Color {
    val hash = userId.fold(0) { value, char -> value * 31 + char.code }
    return avatarColors[(kotlin.math.abs(hash.toLong()) % avatarColors.size).toInt()]
}
