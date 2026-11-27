package anchor

internal interface SessionStore {
    suspend fun read(): ByteArray?
    suspend fun write(value: ByteArray)
    suspend fun clear()
}
