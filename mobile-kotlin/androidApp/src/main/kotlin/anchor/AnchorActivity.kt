package anchor

import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.view.WindowCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider

class AnchorShareViewModel : ViewModel() {
    val shares = AndroidShareCallbacks()
    val launches = AndroidNoteLaunchCallbacks()
}

class AnchorActivity : ComponentActivity() {
    private val oidcCallbacks = OidcBrowserCallbacks()
    private val callbacks by lazy { ViewModelProvider(this)[AnchorShareViewModel::class.java] }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
            Configuration.UI_MODE_NIGHT_YES
        updateSystemBars(dark)
        intent?.dataString?.let(oidcCallbacks::accept)
        if (savedInstanceState == null) intent?.let {
            callbacks.shares.accept(this, it)
            callbacks.launches.accept(it)
        }
        setContent { AndroidAnchorApp(this, oidcCallbacks, callbacks.shares, callbacks.launches, ::updateSystemBars) }
    }

    private fun updateSystemBars(dark: Boolean) {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.dataString?.let(oidcCallbacks::accept)
        callbacks.shares.accept(this, intent)
        callbacks.launches.accept(intent)
    }
}
