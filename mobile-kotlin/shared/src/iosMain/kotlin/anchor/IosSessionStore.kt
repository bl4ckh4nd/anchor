@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package anchor

import kotlinx.cinterop.CPointerVar
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.usePinned
import kotlinx.cinterop.value
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import platform.CoreFoundation.CFDataCreate
import platform.CoreFoundation.CFDataGetBytePtr
import platform.CoreFoundation.CFDataGetLength
import platform.CoreFoundation.CFDataRef
import platform.CoreFoundation.CFDictionaryCreateMutable
import platform.CoreFoundation.CFDictionarySetValue
import platform.CoreFoundation.CFMutableDictionaryRef
import platform.CoreFoundation.CFRelease
import platform.CoreFoundation.CFStringCreateWithCString
import platform.CoreFoundation.CFTypeRef
import platform.CoreFoundation.kCFBooleanTrue
import platform.CoreFoundation.kCFStringEncodingUTF8
import platform.CoreFoundation.kCFTypeDictionaryKeyCallBacks
import platform.CoreFoundation.kCFTypeDictionaryValueCallBacks
import platform.Security.SecItemAdd
import platform.Security.SecItemCopyMatching
import platform.Security.SecItemDelete
import platform.Security.SecItemUpdate
import platform.Security.errSecDuplicateItem
import platform.Security.errSecItemNotFound
import platform.Security.errSecSuccess
import platform.Security.kSecAttrAccessible
import platform.Security.kSecAttrAccessibleWhenUnlockedThisDeviceOnly
import platform.Security.kSecAttrAccount
import platform.Security.kSecAttrService
import platform.Security.kSecClass
import platform.Security.kSecClassGenericPassword
import platform.Security.kSecReturnData
import platform.Security.kSecValueData
import platform.posix.memcpy

internal class IosSessionStore(private val serverHeaders: Boolean = false) : SessionStore {
    override suspend fun read(): ByteArray? = withContext(Dispatchers.Default) {
        query { selector ->
            CFDictionarySetValue(selector, kSecReturnData, kCFBooleanTrue)
            memScoped {
                val output = alloc<CPointerVar<*>>()
                output.value = null
                val status = SecItemCopyMatching(selector, output.ptr.reinterpret())
                if (status == errSecItemNotFound) return@memScoped null
                checkStatus(status)
                val data: CFDataRef = checkNotNull(output.value).reinterpret()
                try {
                    ByteArray(CFDataGetLength(data).toInt()).also { bytes ->
                        if (bytes.isNotEmpty()) bytes.usePinned {
                            memcpy(it.addressOf(0), CFDataGetBytePtr(data), bytes.size.toULong())
                        }
                    }
                } finally {
                    CFRelease(data)
                }
            }
        }
    }

    override suspend fun write(value: ByteArray) = withContext(Dispatchers.Default) {
        val data = value.usePinned { pinned ->
            checkNotNull(CFDataCreate(null, pinned.addressOf(0).reinterpret(), value.size.toLong()))
        }
        try {
            query { selector ->
                CFDictionarySetValue(selector, kSecAttrAccessible, kSecAttrAccessibleWhenUnlockedThisDeviceOnly)
                CFDictionarySetValue(selector, kSecValueData, data)
                val status = SecItemAdd(selector, null)
                if (status == errSecDuplicateItem) {
                    query { existing ->
                        dictionary { changes ->
                            CFDictionarySetValue(changes, kSecValueData, data)
                            checkStatus(SecItemUpdate(existing, changes))
                        }
                    }
                } else {
                    checkStatus(status)
                }
            }
        } finally {
            CFRelease(data)
        }
    }

    override suspend fun clear() = withContext(Dispatchers.Default) {
        query {
            val status = SecItemDelete(it)
            if (status != errSecItemNotFound) checkStatus(status)
        }
        if (!serverHeaders) runCatching { IosReminders.publish(null, emptyList()) }
        Unit
    }

    private fun checkStatus(status: Int) {
        check(status == errSecSuccess) { "Keychain operation failed ($status)" }
    }

    private inline fun <T> query(block: (CFMutableDictionaryRef) -> T): T = dictionary { values ->
        CFDictionarySetValue(values, kSecClass, kSecClassGenericPassword)
        stringAttribute(values, kSecAttrService, "com.zhfahim.anchor.compose")
        stringAttribute(values, kSecAttrAccount, if (serverHeaders) "server-headers-v1" else "active-session-v1")
        block(values)
    }

    private fun stringAttribute(values: CFMutableDictionaryRef, key: CFTypeRef?, value: String) {
        val string = checkNotNull(CFStringCreateWithCString(null, value, kCFStringEncodingUTF8))
        try {
            CFDictionarySetValue(values, key, string)
        } finally {
            CFRelease(string)
        }
    }

    private inline fun <T> dictionary(block: (CFMutableDictionaryRef) -> T): T {
        val dictionary = checkNotNull(
            CFDictionaryCreateMutable(null, 0, kCFTypeDictionaryKeyCallBacks.ptr, kCFTypeDictionaryValueCallBacks.ptr),
        )
        try {
            return block(dictionary)
        } finally {
            CFRelease(dictionary)
        }
    }
}
