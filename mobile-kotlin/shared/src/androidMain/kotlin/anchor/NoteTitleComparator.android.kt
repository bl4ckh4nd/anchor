package anchor

import java.text.Collator

internal actual fun noteTitleComparator(): Comparator<String> {
    val collator = Collator.getInstance()
    return Comparator(collator::compare)
}
