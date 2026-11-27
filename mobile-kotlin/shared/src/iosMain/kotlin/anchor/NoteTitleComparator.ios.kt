package anchor

import kotlinx.cinterop.ExperimentalForeignApi
import platform.Foundation.NSString
import platform.Foundation.create
import platform.Foundation.localizedCompare

@OptIn(ExperimentalForeignApi::class)
internal actual fun noteTitleComparator(): Comparator<String> =
    Comparator { a, b -> NSString.create(string = a).localizedCompare(b).toInt() }
