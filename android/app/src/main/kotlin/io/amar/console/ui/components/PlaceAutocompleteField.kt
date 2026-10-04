package io.amar.console.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.amar.console.data.gmaps.GmapsClient
import io.amar.console.data.gmaps.GmapsSession
import io.amar.console.data.gmaps.placeLocationText
import io.amar.console.data.longtail.GSuggestion
import io.amar.console.data.longtail.LatLon
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * A text field with Google Places type-ahead via the hub (port of the SPA's
 * PlaceAutocomplete). Picking a suggestion resolves it to "Name, address" the
 * way Google Calendar fills its location. No Maps key on the hub, or offline →
 * a plain field, never an error.
 */
@Composable
fun PlaceAutocompleteField(
    value: String,
    onValueChange: (String) -> Unit,
    places: GmapsClient,
    label: String,
    modifier: Modifier = Modifier,
) {
    // TextFieldValue so a picked place lands with the caret at its end.
    var field by remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    if (field.text != value) field = TextFieldValue(value, TextRange(value.length))
    var suggestions by remember { mutableStateOf<List<GSuggestion>>(emptyList()) }
    var focused by remember { mutableStateOf(false) }
    var reqId by remember { mutableIntStateOf(0) }
    // Text we just set ourselves from a pick — don't re-suggest it.
    var skipQuery by remember { mutableStateOf<String?>(null) }
    val session = remember { GmapsSession() }
    var bias by remember { mutableStateOf<LatLon?>(null) }
    var biasLoaded by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(field.text) {
        val q = field.text.trim()
        if (q.length < 2 || q == skipQuery) { suggestions = emptyList(); return@LaunchedEffect }
        delay(250)
        if (!places.configured()) return@LaunchedEffect
        if (!biasLoaded) { bias = places.lastKnownLocation(); biasLoaded = true }
        val id = ++reqId
        val res = runCatching { places.autocomplete(q, session, bias) }.getOrDefault(emptyList())
        if (id == reqId) suggestions = res
    }

    fun pick(s: GSuggestion) {
        reqId++ // drop any in-flight suggestions
        suggestions = emptyList()
        skipQuery = s.text
        onValueChange(s.text)
        scope.launch {
            val text = runCatching { placeLocationText(places.place(s.placeId, session)) }.getOrNull()
                ?: return@launch // keep the suggestion text
            skipQuery = text
            onValueChange(text)
        }
    }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        OutlinedTextField(
            value = field,
            onValueChange = { v ->
                if (v.text != field.text) skipQuery = null
                field = v
                if (v.text != value) onValueChange(v.text)
            },
            label = { Text(label) }, singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused },
        )
        if (focused && suggestions.isNotEmpty()) {
            Column(Modifier.heightIn(max = 200.dp).verticalScroll(rememberScrollState())) {
                for (s in suggestions) {
                    Row(
                        Modifier.fillMaxWidth().clickable { pick(s) }.padding(vertical = 6.dp, horizontal = 4.dp),
                        verticalAlignment = Alignment.Top,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Icon(
                            Icons.Outlined.Place, null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(14.dp).padding(top = 2.dp),
                        )
                        // One AnnotatedString: a second Text beside a long one wraps per char.
                        val secondary = MaterialTheme.colorScheme.onSurfaceVariant
                        Text(
                            buildAnnotatedString {
                                append(s.mainText)
                                s.secondaryText?.let { withStyle(SpanStyle(color = secondary)) { append("  $it") } }
                            },
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 2, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}
