package anchor

import androidx.compose.material3.SwitchDefaults
import androidx.compose.foundation.layout.heightIn
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import androidx.compose.foundation.layout.heightIn

@Composable
internal fun AccountSettings(
    api: AnchorApi,
    session: AnchorSession,
    appearance: AnchorAppearance?,
    onAppearance: (AnchorAppearance) -> Unit,
    density: AnchorDensity,
    onDensity: (AnchorDensity) -> Unit,
    showCardPictures: Boolean,
    onShowCardPictures: (Boolean) -> Unit,
    startNewNotesInBody: Boolean,
    onStartNewNotesInBody: (Boolean) -> Unit,
    noteFont: NoteFont,
    onNoteFont: (NoteFont) -> Unit,
    noteTextSize: NoteTextSize,
    onNoteTextSize: (NoteTextSize) -> Unit,
    sortChecklistItems: Boolean,
    onSortChecklistItems: (Boolean) -> Unit,
    onDelete: suspend (String?) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var profile by remember { mutableStateOf<AccountProfile?>(null) }
    var name by remember { mutableStateOf("") }
    var currentPassword by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }
    var deletionOpen by remember { mutableStateOf(false) }
    var deletionPassword by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }

    fun request(fallback: String, work: suspend () -> Unit) {
        if (busy) return
        busy = true
        message = ""
        scope.launch {
            try {
                work()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                val failure = error as? AnchorHttpFailure
                message = when {
                    failure?.code == "INVALID_PASSWORD" -> "The current password was not accepted."
                    failure?.code == "PASSWORD_UNCHANGED" -> "Choose a different password."
                    failure?.code == "LAST_ADMIN" -> "Make someone else an administrator before deleting this account."
                    failure?.status == 409 -> "Your password changed in another request. Try again."
                    failure?.status == 429 -> "Too many attempts. Try again later."
                    else -> fallback
                }
            } finally {
                busy = false
            }
        }
    }

    fun loadProfile() = request("Could not load your profile. Try again.") {
        val loaded = api.accountProfile(session)
        name = loaded.name
        profile = loaded
    }

    val pickPicture = rememberPickAttachment(profileImage = true) { result ->
        result.fold(
            onSuccess = { file ->
                if (file != null) request("Could not upload the picture. Try again.") {
                    val path = api.uploadProfileImage(session, file)
                    profile = profile?.copy(picture = path)
                    message = "Picture saved."
                }
            },
            onFailure = { message = "Pick a JPG, PNG or WebP picture up to 5 MB." },
        )
    }

    LaunchedEffect(session) { loadProfile() }
    AccountSection("Appearance", "Choose how Anchor looks.") {
        Segmented(
            AnchorAppearance.entries, appearance, AnchorAppearance::label, onAppearance,
            enabled = appearance != null, icon = { themeIcon(it) },
        )
        AccountOptions("Display density", AnchorDensity.entries, density, appearance != null, AnchorDensity::label, onDensity)
        AccountSwitch("Pictures on note cards", showCardPictures, appearance != null, onShowCardPictures)
    }
    AccountSection("Editor") {
        val noteType = LocalNoteTypography.current
        Text("Weekend plans", style = noteType.style(MaterialTheme.typography.titleLarge, scaled = true))
        Text("Pack light. The hills are steep, and the trams fill up by nine.",
            style = noteType.style(MaterialTheme.typography.bodyLarge, scaled = true))
        AccountOptions("Font", NoteFont.entries, noteFont, appearance != null, NoteFont::label, onNoteFont)
        AccountOptions("Text size", NoteTextSize.entries, noteTextSize, appearance != null, NoteTextSize::label, onNoteTextSize)
        AccountSwitch("Move checked items to the bottom", sortChecklistItems, appearance != null, onSortChecklistItems)
        AccountSwitch("Start new notes in the body", startNewNotesInBody, appearance != null, onStartNewNotesInBody)
    }
    if (!deletionOpen && message.isNotEmpty()) {
        AnchorBanner(message, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, tone = BannerTone.Info)
    }
    val current = profile
    if (current == null) {
        if (busy) Text("Loading profile…", color = MaterialTheme.colorScheme.onSurfaceVariant)
        else if (message.isNotEmpty()) AnchorButton("Retry", { loadProfile() }, tone = ButtonTone.Secondary, small = true)
        return
    }

    val field = Modifier.fillMaxWidth()
    AccountSection("Profile", "How you appear to people you share notes with.") {
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
            ProfilePicture(api, session, current)
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AnchorButton("Upload a picture", pickPicture, tone = ButtonTone.Secondary, small = true, enabled = !busy)
                    if (current.picture != null) {
                        AnchorButton("Remove", {
                            request("Could not remove the picture. Try again.") {
                                api.removeProfileImage(session)
                                profile = current.copy(picture = null)
                                message = "Picture removed."
                            }
                        }, tone = ButtonTone.Ghost, small = true, enabled = !busy)
                    }
                }
                Text(
                    "JPG, PNG or WebP, up to 5 MB.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        AnchorField(name, { name = it }, "Name", field, icon = AnchorIcons.User, enabled = !busy)
        AnchorField(
            current.email, {}, "Email", field, icon = AnchorIcons.Mail, readOnly = true,
            hint = "Only an admin can change your email.",
        )
        AnchorButton("Save name", {
            if (name.trim().length > 100) {
                message = "Enter a name of up to 100 characters."
            } else request("Could not save your name. Try again.") {
                val updated = api.updateProfile(session, name.trim())
                name = updated
                profile = current.copy(name = updated)
                message = "Name saved."
            }
        }, enabled = !busy && name.isNotBlank() && name.trim() != current.name)
    }
    if (current.hasPassword) {
        AccountSection("Password") {
            AnchorField(
                currentPassword, { currentPassword = it }, "Current password", field, icon = AnchorIcons.Lock,
                enabled = !busy, password = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            )
            AnchorField(
                newPassword, { newPassword = it }, "New password", field, icon = AnchorIcons.Lock,
                hint = "At least 8 characters.", enabled = !busy, password = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            )
            AnchorButton("Change password", {
                if (newPassword.encodeToByteArray().size > 72) {
                    message = "Use at most 72 bytes."
                } else request("Could not change your password. Try again.") {
                    api.changePassword(session, currentPassword, newPassword)
                    currentPassword = ""
                    newPassword = ""
                    message = "Password changed."
                }
            }, enabled = !busy && currentPassword.isNotEmpty() && newPassword.length >= 8)
        }
    } else {
        AccountSection("Password") {
            Text("Your password is managed by your identity provider.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    AccountSection("Delete account") {
        Text("This can’t be undone", style = MaterialTheme.typography.titleSmall)
        Text(
            "To keep a copy of your notes, export them in the web app first.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        AnchorButton("Delete account", {
            message = ""
            deletionOpen = true
        }, tone = ButtonTone.Danger, small = true, enabled = !busy)
    }
    if (deletionOpen) {
        val dismiss = {
            deletionOpen = false
            deletionPassword = ""
            message = ""
        }
        ConfirmDialog(
            title = "Delete your account?",
            text = "This can’t be undone. Your account, notes, tags, attachments and reminders will be permanently deleted from this server. Notes you shared will no longer be available to other people.",
            confirmLabel = if (busy) "Deleting…" else "Delete account",
            enabled = !busy,
            confirmEnabled = !busy && (!current.hasPassword || deletionPassword.isNotEmpty()),
            onDismiss = dismiss,
            onConfirm = { request("Could not delete the account. Try again.") { onDelete(deletionPassword.takeIf { current.hasPassword }) } },
        ) {
            if (current.hasPassword) {
                AnchorField(
                    deletionPassword, { deletionPassword = it }, "Password", field.padding(top = 12.dp), icon = AnchorIcons.Lock,
                    hint = "Enter your password to confirm.", enabled = !busy, password = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                )
            }
            if (message.isNotEmpty()) AnchorBanner(
                message, Modifier.padding(top = 12.dp).semantics { liveRegion = LiveRegionMode.Polite }, tone = BannerTone.Error,
            )
        }
    }
}

@Composable
private fun ProfilePicture(api: AnchorApi, session: AnchorSession, profile: AccountProfile) {
    val path = profile.picture
    var bitmap by remember(session, path) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(session, path) {
        if (path != null) {
            bitmap = try {
                decodeAttachmentImage(api.downloadProfileImage(session, path))
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                null
            }
        }
    }
    val image = bitmap
    val avatar = Modifier.size(64.dp).clip(CircleShape)
    if (image != null) {
        Image(image, "Profile picture", avatar, contentScale = ContentScale.Crop)
    } else {
        Avatar(initialsOf(profile.name.ifBlank { profile.email }), avatarColor(session.userId), 64.dp)
    }
}

@Composable
private fun <T> AccountOptions(
    title: String, options: List<T>, selected: T, enabled: Boolean, label: (T) -> String, onChange: (T) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Segmented(options, selected, label, onChange, enabled = enabled)
    }
}

@Composable
private fun AccountSwitch(label: String, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(label, Modifier.weight(1f))
        Switch(
            checked, onCheckedChange = null, enabled = enabled,
            colors = SwitchDefaults.colors(checkedTrackColor = MaterialTheme.colorScheme.tertiary),
        )
    }
}

@Composable
private fun AccountSection(
    title: String,
    description: String? = null,
    content: @Composable () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SectionLabel(title, Modifier.padding(start = 4.dp))
        if (description != null) {
            Text(
                description, Modifier.padding(start = 4.dp),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        SettingsGroup {
            Column(Modifier.padding(vertical = 12.dp, horizontal = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                content()
            }
        }
    }
}
