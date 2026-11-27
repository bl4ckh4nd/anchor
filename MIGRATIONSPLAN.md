# Bordo auf Kotlin Multiplatform, Convex und Effect migrieren

Dieser Plan dokumentiert den Ausgangspunkt und die Ziele der Migration.
Die Startanleitung steht im [Bordo-Hosting-Handbuch](docs/hosting.md).

## Ziel und Umfang

Android und iOS wechseln von Flutter auf Kotlin Multiplatform mit Compose Multiplatform. Convex übernimmt die Anwendungsdaten und Geschäftslogik. Effect wird Teil des TypeScript-Backends und übernimmt die Modellierung und Ausführung von Abläufen mit erwartbaren Fehlern, Wiederholungen und externen Abhängigkeiten.

Der Plan geht vom Erhalt der veröffentlichten Funktionen auf Android, iPhone, iPad und im bestehenden Web aus. Die zusätzlichen Flutter-Runner für Desktop und Browser sind kein Release-Ziel. Die Web-Oberfläche wird auf TanStack Start portiert und gegen denselben Convex-Vertrag wie Compose geprüft.

Die bereits gewählte frische lokale Convex-Datenbank bleibt das erste Ziel. Ein Upgrade für existierende Self-Hosting-Installationen ist eine eigene Abnahmestufe. Ein frischer Start ersetzt dort keinen Datenumzug.

## Ausgangslage vor der Migration

- Im Backend gibt es 94 bestehende HTTP- und SSE-Handler und einen neu hinzugekommenen Token-Austausch. Die NestJS-Controller, Prisma-Schemata und E2E-Spezifikationen sind die Verhaltensreferenz. [Server-Spezifikationen](server/test/e2e/specs)
- Der Convex-Prototyp deckt Anlegen, Lesen, Teilen und Aktualisieren einer Notiz ab. Der isolierte Test hat JWT-Prüfung, Berechtigungen, Zugriffsentzug und konkurrierende Änderungen derselben Version verifiziert. [Convex-Notizen](convex-backend/convex/notes.ts)
- Eine gültige Bordo-Sitzung konnte im E2E-Test ein 60 Sekunden gültiges Convex-Token beziehen und damit eine Notiz anlegen. Anmeldung und Sitzungsverwaltung liegen weiterhin in NestJS. [Session-E2E](server/test/e2e/specs/convex-session.e2e-spec.ts)
- Flutter speicherte die Daten pro Nutzer in SQLite mit Drift. Schema-Version 12 enthält unter anderem Notizen, Tags, Anhänge, Revisionen und Sync-Zustand. Unübertragene Änderungen können in Dirty-Flags und gespeicherten Basiswerten liegen. Die Definition steht im letzten Flutter-Stand unter `mobile/lib/core/database/app_database.dart`.
- Der bestehende Serverexport ist für einen synthetischen Datentransfer erprobt. Er portiert weder die Relationen in das endgültige Convex-Schema noch die eigentlichen Anhänge. [Exportskript](docker/export-convex-data.py)

## Zielarchitektur

| Bereich | Entscheidung |
| --- | --- |
| Mobil | Gemeinsamer Kotlin-Code für Modelle, Datenbank, Sync, Auth-Client und die regulären Compose-Screens. Android und iOS kapseln Secure Storage, Browser-Callbacks, Benachrichtigungen, Medien und Hintergrundverhalten. Bestehenden Android-Widget- und Share-Code sowie die iOS Share Extension nach Prüfung wiederverwenden. |
| Lokale Daten | Room KMP mit SQLite als Ziel. Pro Serverinstanz und Nutzer getrennte Daten. Ktor und Kotlin-Serialisierung für denselben HTTP-Vertrag auf beiden Plattformen. Compose liest aus der lokalen Datenbank. [Room für KMP](https://developer.android.com/kotlin/multiplatform/room) · [Plattformstabilität](https://kotlinlang.org/docs/multiplatform/supported-platforms.html) |
| Client-Vertrag | Die bestehende Serveradresse und die dokumentierten Verträge unter `/api` bleiben während der Übergangszeit nutzbar. HTTP-Sync liefert Daten und Cursor, SSE ist ein Signal für einen erneuten Pull. Kotlin verwendet diesen gemeinsamen Vertrag. Damit hängt iOS nicht von der Android-Clientbibliothek ab. [Convex Android SDK](https://docs.convex.dev/client/android/overview) |
| Convex | Self-hosted auf PostgreSQL mit Convex-verwaltetem Schema. Convex-Queries und -Mutations übernehmen Lesen, Berechtigungen und atomare Änderungen. Interne Actions übernehmen bei Bedarf Node-kompatible Bibliotheken und externe I/O. Der Reverse Proxy erhält die bestehenden öffentlichen Pfade und Origins. [Convex-Runtimes](https://docs.convex.dev/functions/runtimes) · [Self-Hosting](https://github.com/get-convex/convex-backend/tree/main/self-hosted) |
| Effect | Typisierte Anwendungsfehler und Validierung an den HTTP-Grenzen. Begrenzte Retries für vorübergehende I/O-Fehler, Ressourcenfreigabe bei Datei- und Importabläufen und strukturierte Logs. Convex-Validatoren bleiben an den Funktionsgrenzen und im Datenbankschema. [Effect](https://effect.website/docs/v4/onboarding) · [Retry-Regeln](https://effect.website/docs/v4/error-management/retrying) |

Ein HTTP-Handler führt ein Effect-Programm aus und übersetzt erwartbare Fehler einmal in den bestehenden Statuscode und Antwortkörper. Berechtigungen und Versionsprüfung erfolgen in Convex, bei Schreibvorgängen in derselben Mutation wie die Änderung. Felder wie Owner, Nutzer-ID und Rollen stammen aus der verifizierten Identität oder aus der Datenbank. Effect führt keine externen Operationen innerhalb einer Mutation aus. Ein Retry für einen schreibenden externen Aufruf setzt voraus, dass sich derselbe Vorgang anhand eines stabilen Schlüssels wiedererkennen lässt.

Phase 1 prüft Effect im gepinnten self-hosted Build mit einem echten HTTP-Handler und einer Node-Action. Wenn eine Effect-Integration im Standard-Runtime scheitert, bleiben die dortigen Queries und Mutations bei Convex-Primitiven. Effect läuft dann an den Node- und I/O-Grenzen. Für langlebiges SSE und große Datei-Streams wird zuerst der echte Betrieb über den vorgesehenen Proxy geprüft. Falls die Convex-Runtime den bestehenden Vertrag nicht zuverlässig bedienen kann, bleibt ein kleiner HTTP-Dienst für genau diese Aufgaben. Die fachlichen Daten bleiben in Convex.

## Umsetzung in acht Phasen

Die Schätzung gilt für eine erfahrene Vollzeitkraft mit Kotlin- und TypeScript-Erfahrung. Sie umfasst Android, iOS, Web-Kompatibilität, Backend-Parität und ein erprobtes Bestandsupgrade. Store-Reviews, Beschaffung von Signierzugängen und Wartezeit für einen gestaffelten Rollout kommen hinzu.

| Phase | Arbeit und Abnahme | Personentage |
| --- | --- | ---: |
| 1. Verträge und Machbarkeit | Alle 95 Handler mit Aufrufern, Wire-Format, Auth, Fehlern und vorhandenen Tests erfassen. Release-Plattformen und älteste unterstützte Versionen festhalten. KMP-Build auf Linux und macOS, Editor-Roundtrip, Effect-Runtime, SSE und 50-MiB-Upload durch den echten Proxy prüfen. Eine passende Versionskombination festschreiben. | 3–5 |
| 2. Erster durchgängiger Ablauf | Kotlin-App mit Serverauswahl, Anmeldung über den bestehenden Bordo-Vertrag, lokalem Speichern und einem echten Convex-Notizfluss. Der Session-Austausch bleibt während dieser Phase die Brücke. Derselbe Test läuft auf Android, iOS und im Web. | 4–7 |
| 3. Identität und Betrieb | Produktionsfähige Authentifizierung, Konten, Administration und Protokollprüfung portieren. OIDC, Passwort, Sitzungen, 2FA, Passkeys, API-Tokens, Account-Löschung und Schlüsselrotation abnehmen. | 5–9 |
| 4. Notizen und Sync | Vollständiges Notizmodell und den bestehenden Push/Pull-Vertrag portieren. Teilen, Verlauf, Archiv, Papierkorb, Tags, Pinning, Positionen und Erinnerungen abnehmen. Alte und neue Clients gegen identische Vertrags-Fixtures testen. | 7–12 |
| 5. Dateien und Datentransfer | Anhänge und Avatare, alle unterstützten Import-/Export-Formate und Aufräumjobs portieren. Servermigration mit Datenabgleich sowie Backup/Restore unter echten Betriebsbedingungen proben. | 6–10 |
| 6. Kotlin-Funktionsparität | Flutter-Screens und Plattformintegrationen vervollständigen. Rich-Text-Editor, Suche, Board/Liste, Verlauf, Teilen, Erinnerungen, Widget, Share Intake, Barrierefreiheit und Übersetzungen abnehmen. Upgrade aus veröffentlichten Flutter-Builds mit ungesendeten Änderungen prüfen. | 12–20 |
| 7. Web und alte Clients | TanStack Start gegen den Convex-basierten Vertrag prüfen. Legacy-Flutter und dokumentierte API-Token-Integrationen innerhalb des festgelegten Supportfensters freigeben. Docker-Start, Proxy und öffentliche Callback-Adressen mit dem Release-Build prüfen. | 5–9 |
| 8. Cutover und Rollback-Probe | Frischen lokalen Cutover durchführen und abnehmen. Für Bestandsinstallationen beschriebene Downtime, Wiederherstellung und Rückweg mit neuen Daten proben. Signierte Beta-Artefakte erstellen, Freigabe einholen und Ablösung der Altkomponenten dokumentieren. | 6–10 |
| **Gesamt** | **Richtwert. Nach Phase 1 anhand der tatsächlichen Editor-, Auth- und Upgrade-Befunde neu schätzen.** | **48–82** |

Phase 2 hängt von Phase 1 ab. Danach können die fachliche Backend-Parität und die Kotlin-Oberfläche gegen den festgelegten Vertrag unabhängig vorankommen. Die erste brauchbare Beta braucht den Kern aus Phasen 2 bis 4, den Datei- und Upgrade-Pfad sowie die zugehörigen Abnahmetests. Der öffentliche Cutover braucht alle Phasen.

### Identität und Autorisierung

- Ziel ist eine Convex-basierte Bordo-Identität unter dem öffentlichen Bordo-Origin. Bestehende Sitzungs- und Anmeldeverträge bleiben bis zum bewussten Protokollwechsel verfügbar. Auth-Bibliotheken für Passwort, TOTP, OIDC und WebAuthn zuerst gegen reale Flows prüfen und ausgewählte, bewährte Implementierungen wiederverwenden. Node-gebundene Kryptografie nur serverseitig ausführen.
- Bei einem Bestandsupgrade stabile Nutzer-IDs, Anbieter-IDs, Passwort-Hashes, Passkeys und verschlüsselte TOTP-Daten einschließlich der nötigen Betriebsgeheimnisse erhalten. OIDC-Weiterleitungen, PKCE/State und WebAuthn-RP-ID am echten Host verifizieren. Für bestehende Refresh- und API-Tokens am Ende von Phase 1 festlegen, ob sie sicher übernommen oder mit dokumentierter Neuanmeldung beziehungsweise Rotation abgelöst werden.
- Erneuerung, parallele Refresh-Anfragen, Widerruf, Pending-Accounts, Adminrollen, Recovery Codes und Rate Limits prüfen. Der aktuelle Übergangstoken bleibt bis zum Ablauf nutzbar. Für sensible Zugriffe aktuellen Konto- und Berechtigungszustand serverseitig prüfen. Admin- und Signierschlüssel bleiben außerhalb der Clients. [Custom JWT in Convex](https://docs.convex.dev/auth/advanced/custom-jwt)

### Datenmodell und Sync

- Öffentliche Note-, User- und Attachment-IDs erhalten. Convex-`_id` bleibt intern. Eindeutigkeit pro Instanz und die korrekten Owner-/Share-Relationen in Mutations durchsetzen. Kontopersonalisierung und Notizversion getrennt behandeln, damit ein gleichzeitiger Pin oder eine persönliche Einstellung keinen fremden Entwurf überschreibt.
- `POST /api/sync` übernimmt weiterhin Push vor Pull, Protokollverhandlung, Cursor, Snapshot, paginierte Deltas und die Status `applied`, `conflict`, `denied` und `failed`. Change-Log-Einträge mit der auslösenden Mutation atomar schreiben. Cursor-Fortschritt und lokale Anwendung einer Seite gemeinsam speichern. Der Client liest Dezimalstrings exakt und behandelt Cursor als opak. [Bestehender Sync-Vertrag](server/src/sync/dto/sync-response.dto.ts)
- Kotlin speichert lokale Notizänderung und ausstehenden Vorgang transaktional. Nach Verbindungsabbruch oder Prozessende überlebt die Warteschlange. Bei fehlender Quittung ist erneute Zustellung sicher. Ältere Clients behalten ihr beobachtbares Verhalten. Neue Clients halten einen Konfliktentwurf zum Wiederherstellen fest, soweit die Berechtigung das erlaubt. Bei entzogener Freigabe werden lokale Kopien, Cache-Dateien und geplante Benachrichtigungen nach der nächsten Autorisierungsprüfung bereinigt.
- E2E muss Änderungen zwischen Snapshot-Seiten, Cursor-Verfall, zwei gleichzeitig schreibende Geräte, die verspätete Sync-Antwort nach einem neueren lokalen Edit, Zugriffsentzug, Reconnect ohne SSE und Neustart mit ausstehenden Änderungen abdecken. Bei einem Instanzwechsel wird der Cursor zurückgesetzt und der Snapshot neu aufgebaut. Ausstehende Änderungen bleiben an die ursprüngliche Serverinstanz gebunden und werden vor der Wiederholung gegen den neuen Serverzustand abgeglichen.

### Kotlin-App und Flutter-Upgrade

- Die aktuelle Weboberfläche ist die Designreferenz für Compose. Farben, Typografie, Bedienelemente und die Gliederung der Ansichten aus der Webversion übernehmen und für schmale Displays sowie native Bedienung anpassen. Die Portierung im hellen und dunklen Modus auf Geräten prüfen.
- Das Projekt zunächst neben Flutter entwickeln. Kotlin übernimmt vorhandene IDs, URL-Schemes, App Groups, Store-Signierung und höhere Buildnummern für echte In-place-Upgrades. Android-Testinstallation und iOS-Simulatorbuild starten früh. Mindestens ein signiertes Upgrade pro Plattform auf realer Hardware prüfen.
- Als erste Editor-Aufgabe gespeicherte Quill-Deltas mit Web und beiden Kotlin-Targets verlustfrei lesen und speichern. Repräsentative Fixtures enthalten Formatierungen, Checklisten, Links, Bilder, Audio und unbekannte Attribute. Native Editor-Komponenten sind zulässig, wenn Compose den Roundtrip, Eingabemethoden, Auswahl oder Barrierefreiheit nicht zuverlässig abdeckt. Ein Rollout mit stiller Konvertierung in Plain Text ist ausgeschlossen.
- Für das Update eine neue SQLite-Datenbank transaktional befüllen. Die geschlossene alte Drift-Datenbank inklusive konsistentem WAL-Zustand lesen. Alte Dateien bleiben bis zur erfolgreich geprüften Migration erhalten. Nutzer und Serverzuordnung eindeutig prüfen. Notizen, Dirty-Flags, Basisversionen, Revisionen, lokale Anhänge und Eingangsdaten der Share Extension vollständig übernehmen. Die Kopie ist nach Abbruch wiederholbar. Ein nötiger erneuter Login löscht keine Entwürfe.
- Upgrade-Fixtures aus dem aktuellen und mindestens einem älteren unterstützten Flutter-Build verwenden. Auf beiden Plattformen ein echtes Offline-Upgrade mit ungesendeter Notiz, Datei und löschender Änderung prüfen. Fehlt ein sicher lesbarer Altzustand, bleibt der veröffentlichte Flutter-Pfad verfügbar, bis ein Zwischenrelease die Daten verlustfrei exportieren oder übergeben kann.
- Geräteabnahme umfasst Android-Widget, iOS Share Extension, Aufnahme und Download, Hintergrund- und Vordergrundwechsel, Systembenachrichtigungen, Zeitzonen und Sommerzeit, manuelle Serverauswahl und Kontowechsel. Die Plattform übernimmt die Terminierung von Hintergrundarbeit. Die App synchronisiert zusätzlich beim Start und bei Wiederverbindung.

### Anhänge, Import und Export

- Upload-Autorisierung an Nutzer und Notiz binden. Einen Upload erst nach erfolgreicher Größen-, Format- und Rechteprüfung als Anhang verknüpfen. Abbruch, abgelaufene Berechtigung, wiederholte Finalisierung und verwaiste Dateien abnehmen. Downloads über einen autorisierten Pfad ausliefern. Keine langlebigen, direkt zugänglichen Datei-URLs für private Anhänge in Sync- oder API-Antworten.
- Für neue Clients einen direkten Upload mit nachgelagerter Prüfung erproben. Der bestehende Multipart-Pfad braucht einen streamenden Kompatibilitätsweg, weil Bordo 50 MiB erlaubt und Convex HTTP Actions Multipart auf 20 MiB begrenzen. 50 MiB und den ersten abgewiesenen Bytewert im Deployment testen. Audio-Suche per Range, Wiederaufnahme nach Abbruch und Download nach Freigabeentzug mitprüfen. [Convex-Uploads](https://docs.convex.dev/file-storage/upload-files) · [HTTP-Action-Limits](https://docs.convex.dev/functions/http-actions) · [Bordo-Limit](server/src/notes/constants/notes.constants.ts)
- Den bestehenden Datenexport als Quelle für das Datenmapping nutzen. Zielimport für Relationen, Binärdaten und stabile IDs ergänzen. Tabellenanzahl, Schlüssel, Referenzen, Sichtbarkeit, Versionswerte und SHA-256 jedes referenzierten Blobs abgleichen. Backups benötigen Datenbank, Dateispeicher und für die Wiederherstellung notwendige Konfiguration und Schlüssel. Restore auf einer isolierten Instanz belegen.
- Nutzerseitige Bordo-ZIP-Backups, Markdown- und Google-Keep-Import separat vom Serverumzug abnehmen. Fehlerhafte oder abgebrochene Importe dürfen weder unzugängliche Teilbibliotheken hinterlassen noch bei einem Wiederholungsversuch Daten duplizieren.

## Test- und Freigabestrategie

- Für jeden nichttrivialen Ablauf zuerst einen reproduzierbaren fehlgeschlagenen Vertrags- oder E2E-Check erstellen. Vorhandene NestJS-Spezifikationen als Referenz und Regressionen weiterverwenden. Bei einem isolierten Test die erwarteten Fehlerfälle vor der Implementierung festhalten.
- Bestehende Pflichtchecks bleiben aktiv, solange ihre Pfade unterstützt werden. CI baut das gepinnte Self-Hosting-Image, führt die Convex-Verträge aus und erzeugt Android- und iOS-Testartefakte. Browserabnahme im In-App-Browser per Playwright CLI. Auf Linux Android-Emulator-Tests, auf macOS iOS-Simulator-Tests, anschließend die genannten Prüfungen auf echten Geräten.
- Jede Freigabe enthält Commit-SHA, Image-Digest, Client-Versionen, getestete Plattformen und reproduzierbare Befehle. E2E-Artefakte sind JUnit/JSON, fehlerbezogene Traces und für Migrationen ein Vergleichsmanifest ohne private Nutzerdaten. Bei einem Upgrade gehören auch die Ausgangs-Buildnummer und der Restore-Nachweis dazu.
- In einer repräsentativen Bibliothek Dauer von App-Start, lokalem Speichern, vollem Pull und Wiederverbindung messen. Im Ziel-Stack Speicherbedarf, Persistenz nach Restart, Fehlerquote, Warteschlangenalter, Sync-Konflikte und Upload-Abbrüche erfassen. Phase 1 setzt die Grenzwerte anhand der Bestandsmessung. Im Rollout werden Zahlen und Fehler lokal und ohne Notizinhalte oder Tokens erfasst.

## Reihenfolge beim Cutover und beim Rückweg

1. **Frischer lokaler Cutover.** Den Ziel-Stack auf der vorgesehenen frischen Instanz starten. Signierkonfiguration, Volumes, Proxy und Backup/Restore prüfen. Web sowie Kotlin Android und iOS gegen denselben Host abnehmen. Die bestehende Entwicklungsinstanz bleibt als Vertragsreferenz verfügbar.
2. **Bestandsupgrade proben.** Einen synthetischen und anschließend einen ausdrücklich freigegebenen repräsentativen Bestand migrieren. Nutzercache und Entwürfe auf Geräten separat prüfen. Fehlerfälle mit absichtlich abgebrochenem Export, Import und Proxy-Wechsel aufnehmen. Einen dokumentierten Server-Preflight mit Platzbedarf, Downtime und benötigten Schlüsseln liefern.
3. **Bestandsinstallation umstellen.** Wartungsmodus gegen neue Schreibvorgänge setzen, laufende Mutationen und Dateioperationen beenden, Datenbank und Dateien aus einem konsistenten Stand sichern. Transformieren, importieren und mit dem Manifest abgleichen. Server und Client-Kompatibilität über den tatsächlichen externen Host prüfen. Nach Freigabe API-Routing umschalten und Schreibzugriffe öffnen. Pro Installation und Phase ist genau ein Backend für Schreibvorgänge zuständig.
4. **Rückweg vor Schreibfreigabe.** Bei fehlerhaftem Import oder fehlgeschlagener Abnahme die Route auf die eingefrorene Altinstanz zurückstellen. Beim Rückweg den Wartungsmodus kontrolliert aufheben.
5. **Rückweg nach Schreibfreigabe.** Bei einer Regression zuerst Schreibzugriffe am Convex-Ziel sperren und dessen aktuellen Bestand sichern. Convex aus dem letzten konsistenten Stand wiederherstellen und seither akzeptierte Änderungen nachziehen oder über einen vorher erprobten Rückimport inklusive Dateien in das Altsystem überführen. Wenn kein verlustfreier Rückimport existiert, ist nach Schreibfreigabe nur ein reparierter Convex-Betrieb mit gesicherten neuen Daten vorgesehen. Ein automatisches Zurückschalten auf den vor dem Cutover eingefrorenen Stand würde bereits bestätigte Änderungen verlieren.
6. **Altpfade ablösen.** Erst nach vereinbartem Kompatibilitätsfenster, gemessener Nutzung und grünen Wiederherstellungstests NestJS als Übergang entfernen und Flutter aus den Build- und Release-Pfaden nehmen. Alte signierte Artefakte und zum Restore nötige Werkzeuge bleiben nach der vereinbarten Aufbewahrung verfügbar. Ein Mobil-Rollback ist ein höher versioniertes Fix-Release mit Zugriff auf die aktuellen lokalen Daten.

## Offene Entscheidungen vor der jeweiligen Phase

| Entscheidung | Vorgabe für diesen Plan |
| --- | --- |
| Android und iOS oder Android zuerst | Beide bleiben Release-Ziele. Reihenfolge im Beta-Rollout nach Qualität der Store- und Geräteprüfung. |
| Authentifizierung im Ziel | Bestehende Bordo-Identitäten und Funktionsparität erhalten. Konkrete Bibliotheken, öffentliches JWKS und Übernahme oder Rotation von Sitzungstokens in Phase 1 entscheiden. Die NestJS-Brücke hat ein Ablaufkriterium. |
| Alter Geräte- und Client-Support | Aktuelle Plattformgrenzen und dokumentierte ältere API-Verträge als Ausgangspunkt. Jede Einschränkung braucht eine ausdrückliche Release-Entscheidung. Mac, Signierzugang, Android- und iOS-Geräte für die Abnahme früh einplanen. |
| Bestandsdaten und Produktionsfreigabe | Lokal zuerst frisch. Quellbestand, Wartungsfenster, akzeptabler Datenverlust und Wiederanlaufzeit vor einem Bestandsupgrade ausdrücklich festlegen. Ohne separate Produktionsfreigabe endet die Arbeit bei der lokal oder in Staging abgenommenen Migration. |
| TanStack Start | Die nachträglich freigegebene Portierung der Web-Anwendung ist in der ursprünglichen Schätzung von 48–82 Personentagen nicht enthalten. |

Der erste abnehmbare Auftrag ist ein Vertragsinventar mit einer Zeile je Handler, die Risk-Probes aus Phase 1 und ein dokumentierter Kotlin-Editor-Roundtrip mit einer bestehenden Quill-Notiz auf Android und iOS. Die Migration ist abgeschlossen, wenn der Ziel-Stack alle vereinbarten Verträge erfüllt, beide signierten mobilen Updates ihre Offline-Daten erhalten und die Freigabe auf einem nachweislich wiederherstellbaren Datenstand beruht.
