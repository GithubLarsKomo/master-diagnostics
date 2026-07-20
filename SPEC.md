# SPEC.md — Masters Diagnostics WebApp

**Status:** MVP-Spezifikation  
**Version:** 1.0.0-draft  
**Sprache:** Deutsch  
**Produktart:** Trainerzentrierte WebApp/PWA für sportwissenschaftliche Leistungsdiagnostik  
**Zielgeräte:** Tablet zuerst, danach Desktop und Smartphone  
**Zielgruppen:** Masters-Trainer, Leistungsdiagnostiker, Vereine, Trainingszentren und Masters-Athleten

---

## 1. Produktvision

Die Anwendung unterstützt Trainer bei der standardisierten Planung, Durchführung, Auswertung, Freigabe und Verlaufsanalyse von wattbasierten Laktat-Stufentests auf:

- Concept2 BikeErg
- Concept2 RowErg
- RP3

Der MVP konzentriert sich ausschließlich auf Leistungsdiagnostik. Trainingsplanung, automatische Workout-Steuerung, medizinische Diagnostik, Wettkampfprognosen, Ranglisten und tenantübergreifende Benchmarks sind nicht Bestandteil des MVP.

Das Produkt wird als sportwissenschaftliche Leistungsdiagnostiksoftware positioniert. Es stellt keine medizinische Diagnose, bestätigt keine Sporttauglichkeit und gibt keine Therapieempfehlungen.

---

## 2. MVP-Ziele

Der MVP muss:

1. Multi-Tenant-SaaS-Betrieb ermöglichen.
2. Einen vollständig autarken lokalen Club-Modus ohne externe Cloud-Abhängigkeiten ermöglichen.
3. Trainerzentrierte Durchführung und Auswertung von Stufentests ermöglichen.
4. BikeErg, RowErg und RP3 getrennt behandeln.
5. Vier automatische Schwellenmodelle plus manuelle Trainerentscheidung anbieten.
6. Ein physiologisches Drei-Zonen-Modell und ein praxisnahes Fünf-Zonen-Modell ausgeben.
7. Eine timergeführte, offline-robuste Testdurchführung ermöglichen.
8. DSGVO-konforme Verarbeitung sportbezogener Gesundheitsdaten unterstützen.
9. Revisionssichere Freigaben, Versionierung und Auditierung sicherstellen.
10. Offene Exporte für Athleten, Tenants und alternative Analysewerkzeuge ermöglichen.

---

## 3. Nicht-Ziele des MVP

Nicht Bestandteil des MVP sind:

- Trainingsplanerstellung und Periodisierung
- aktive Ergometersteuerung
- native iOS- oder Android-App
- App-Store-Veröffentlichung
- direkte Integration mit Garmin, Polar, COROS, Suunto oder TrainingPeaks
- CSV-, FIT-, TCX- oder herstellerspezifischer Import
- hochauflösende Rohdatenzeitreihen
- Videoanalyse
- KI-Coaching oder KI-Training mit Athletendaten
- medizinische Diagnostik
- tenantübergreifende Benchmarks oder Ranglisten
- Zahlungsabwicklung oder Stripe-Integration
- vollständiges White-Labeling
- Hochverfügbarkeitscluster

---

## 4. Betriebsmodelle

### 4.1 SaaS-/Cloud-Modus

- Multi-Tenant-fähig
- Clerk als bevorzugter Identity Provider
- Turso Cloud als bevorzugter libSQL-Dienst
- alternativ Better Auth und selbst gehostetes libSQL möglich
- Plattform-Admin zur Tenant-Verwaltung
- logische Tenant-Isolation über `tenant_id`

### 4.2 Autarker Club-Modus

- exakt ein Club-Tenant pro Installation
- keine Plattform-Admin-Oberfläche
- Better Auth als lokaler Identity Provider
- lokaler libSQL-Server in eigenem Container
- persistentes Docker-Volume
- vollständig ohne Internet, Cloud-Auth, Cloud-Datenbank, CDN, Telemetrie oder Lizenzserver nutzbar
- lokaler browserbasierter Setup-Assistent
- Updates online über Registry oder offline über signierte Updatepakete

### 4.3 Gemeinsame Grundsätze

- identisches fachliches Datenmodell
- identische Rollen und Berechtigungen
- identische Drizzle-Migrationen
- keine direkte Datenbankverbindung aus dem Browser
- alle fachlichen Tabellen enthalten `tenant_id`, auch im Single-Tenant-Club-Modus
- Deployment über Docker Compose
- keine Bindung an proprietäre Hosting-Funktionen

---

## 5. Referenzarchitektur

### 5.1 Technologie-Stack

- Next.js App Router
- React
- TypeScript im Strict Mode
- Tailwind CSS
- barrierearme Komponentenbibliothek
- Turso/libSQL
- Drizzle ORM und Drizzle Kit
- Clerk für SaaS/Cloud
- Better Auth für lokalen/autarken Betrieb
- Zod für Eingabevalidierung und versionierte Austauschschemata
- IndexedDB, bevorzugt über Dexie
- Service Worker und Web App Manifest
- Web Bluetooth hinter Adapter-Schnittstellen
- serverseitige PDF-Erzeugung
- Vitest für Unit- und Fachkerntests
- Playwright für End-to-End-, Rollen- und Tenant-Isolationstests
- strukturierte Logs und optionale OpenTelemetry-Anbindung

### 5.2 Fachmodule

```text
identity
├── clerk-provider
└── better-auth-provider

tenancy
users
athletes
coach-assignments
consents
protocols
tests
measurements
quality
thresholds
zones
reports
exports
audit
notifications
bluetooth
sync
backup
updates
setup
```

### 5.3 Provider-Abstraktionen

```ts
interface IdentityProvider {
  getSession(): Promise<IdentitySession | null>;
  inviteUser(input: InviteUserInput): Promise<InviteResult>;
  revokeSession(sessionId: string): Promise<void>;
}

interface DatabaseProvider {
  execute<T>(query: TypedQuery<T>): Promise<T>;
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  healthcheck(): Promise<HealthStatus>;
}
```

Implementierungen:

```text
IdentityProvider
├── ClerkIdentityProvider
└── BetterAuthIdentityProvider

DatabaseProvider
├── TursoCloudProvider
└── LocalLibSQLProvider
```

---

## 6. Rollen- und Berechtigungsmodell

### 6.1 Rollen

- `PLATFORM_ADMIN`
- `TENANT_ADMIN`
- `TRAINER`
- `ATHLETE`

### 6.2 Rollenregeln

#### PLATFORM_ADMIN

Nur im SaaS-/Cloud-Modus.

Darf:

- Tenants anlegen, sperren und administrieren
- Tarif-, Limit- und Feature-Status verwalten
- technische Metadaten und Systemzustände sehen
- Tenant-Importe und -Migrationen verwalten

Darf standardmäßig nicht:

- Diagnostikdaten einsehen
- Athletenberichte öffnen
- fachliche Testdaten bearbeiten

#### TENANT_ADMIN

Darf:

- alle Trainer, Athleten und Zuordnungen des Tenants verwalten
- alle Diagnostikdaten des Tenants sehen
- Trainer und Athleten einladen
- Vorlagen und Zonenregeln konfigurieren
- Tests übernehmen, prüfen, interpretieren und freigeben
- Branding, Datenschutz, Aufbewahrung, Backup und Benachrichtigungen konfigurieren
- Exporte und Löschvorgänge administrieren

Ein Tenant-Admin kann gleichzeitig Trainer sein.

#### TRAINER

Darf:

- zugewiesene Athleten sehen
- Tests planen und durchführen
- Testdaten prüfen und korrigieren
- Schwellenmodelle berechnen
- LT1, LT2 und Zonen festlegen
- Tests freigeben
- Exporte und Berichte für zugewiesene Athleten erzeugen

Ein Athlet kann mehreren Trainern zugeordnet sein. Ein Trainer kann mehrere Athleten betreuen. Optional wird ein Haupttrainer markiert.

#### ATHLETE

Darf:

- eigene freigegebene Tests vollständig einsehen
- automatische Schwellenmodelle, Qualitätskennzeichen und Trainerentscheidung sehen
- eigene Berichte und Exporte abrufen
- freiwillige Kontextdaten pflegen
- Einwilligungen erteilen, widerrufen und Löschung beantragen

Darf nicht:

- Diagnostikdaten ändern
- Testwerte korrigieren
- Schwellen oder Zonen freigeben
- fremde Athletendaten sehen

### 6.3 Verwaltete Athletenprofile

Athleten können ohne eigenes Login als verwaltete Profile existieren. Später eingeladene Nutzerkonten werden mit dem bestehenden Profil verbunden; Testhistorie und Zuordnungen bleiben erhalten.

---

## 7. Tenant-Modell

- Im SaaS-Modus entspricht ein Tenant einer organisatorisch und datenschutzrechtlich eigenständigen Einheit.
- Ein Athlet gehört im MVP genau einem Tenant.
- Trainer und Athleten dürfen nicht tenantübergreifend verknüpft werden.
- Jede fachliche Entität trägt `tenant_id`.
- Zusammengesetzte Fremdschlüssel und serverseitige Autorisierung verhindern tenantübergreifende Beziehungen.
- Alle Datenzugriffe sind serverseitig und rollenbasiert.
- Der Browser erhält keine direkten libSQL- oder Turso-Zugangsdaten.

---

## 8. Athleten-Stammdaten

### 8.1 Pflichtfelder

- Geburtsdatum
- physiologische Referenzkategorie
- Körpergewicht
- Körpergröße
- primäre Sportart
- Disziplin
- Masters-Altersklasse, berechnet aus Geburtsdatum und Testdatum
- Trainingsstatus
- Einwilligungsstatus und Einwilligungsdatum

### 8.2 Optionale Felder

- Ruheherzfrequenz
- bekannte maximale Herzfrequenz
- bisherige Schwellenwerte
- Trainingsumfang pro Woche
- gesundheitliche Einschränkungen
- Medikamente mit möglichem Einfluss auf Herzfrequenz oder Laktat
- Wettkampfklasse
- Bootsklasse
- Gewichtsklasse
- Trainer-Notizen

### 8.3 Änderungsrechte

Athleten dürfen selbst bearbeiten:

- Sprache und Anzeigeeinstellungen
- Kontaktdaten
- Trainingsumfang
- freiwillige gesundheitliche Hinweise
- Medikamente
- Ruhe-HF
- bekannte Maximal-HF
- Einwilligungen

Nur Trainer oder Tenant-Admins dürfen diagnostisch relevante Stammdaten bearbeiten.

Jeder Test speichert einen unveränderlichen Athleten-Snapshot.

---

## 9. Minderjährige

- Minderjährigenstatus wird aus dem Geburtsdatum ermittelt.
- Vor dem ersten Test ist die Zustimmung einer gesetzlichen Vertretung erforderlich.
- Zusätzlich wird eine altersgerechte Einwilligung des Minderjährigen dokumentiert.
- Eigener Login nur nach Freigabe durch Tenant-Admin und Vertretung.
- Bei Volljährigkeit ist eine neue eigene Einwilligung erforderlich.
- Bis dahin werden neue Tests und Freigaben gesperrt.
- Vertreter dürfen Widerrufs- und Löschrechte ausüben.

---

## 10. Testprotokolle

### 10.1 Werksvorlagen

Es existieren drei standardisierte Vorlagen:

- BikeErg
- RowErg
- RP3

Gemeinsame Werkseinstellungen:

- Warm-up: 10 Minuten
- Bereitschaftsphase: 2 Minuten
- Stufendauer: 4 Minuten
- Messpause: 1 Minute
- Laktatprobe innerhalb der ersten 30 Sekunden der Pause
- Ruhewert unmittelbar vor Warm-up
- Nachbelastungswert 5 Minuten nach Belastungsende
- maximal 8 Stufen
- Einbeziehung einer verkürzten Endstufe ab mindestens 50 % der Stufendauer
- akustische Warnungen 30, 10 und 3 Sekunden vor Stufenende

### 10.2 Tenant-Anpassungen

Tenant-Admins dürfen versionierte Vorlagenvarianten anlegen und ändern:

- Vorlagenname
- Gerätetyp
- Startleistung
- Inkrement
- Stufendauer
- Messpause
- Warm-up-Dauer
- Warm-up-Leistung
- Countdown
- Messzeitpunkt der Laktatprobe
- maximale Stufenzahl
- Abbruchhinweise
- aktivierte optionale Eingabefelder

Nicht änderbar:

- wattbasierte lineare Stufenlogik
- genau ein Ruhewert
- genau ein Nachbelastungswert nach 5 Minuten
- Teilstufenregel ab 50 %
- Freigabe-, Audit- und Versionierungsprinzipien

### 10.3 Konkreter Testplan

Beim Anlegen eines Tests wird die ausgewählte Vorlagenversion als unveränderlicher Snapshot kopiert.

Der Trainer darf vor Testbeginn anpassen:

- Startleistung
- Leistungsinkrement
- maximale Stufenzahl

Diese Entscheidung ersetzt die frühere Begrenzung auf Startleistung und Stufenzahl; das Inkrement ist ebenfalls testbezogen anpassbar.

### 10.4 Automatische Planung aus erwarteter LT2

Primäre Eingabe: erwartete LT2-Leistung in Watt.

Standardlogik:

- Startleistung = ca. 60 % der erwarteten LT2
- LT2 wird für Stufe 5 geplant
- Inkrement = `(erwartete LT2 - Startleistung) / 4`
- Rundung auf 5 W
- Ziel: 7 bis 8 Stufen
- vollständige Leistungsfolge vor Start anzeigen
- Warnung bei zu kurzer, zu langer oder unplausibler Planung

Beispiel bei 350 W erwarteter LT2:

```text
210, 245, 280, 315, 350, 385, 420 W
```

---

## 11. Testbedingungen-Snapshot

### 11.1 Pflichtangaben

- Datum
- tatsächliche Startzeit
- Gerätetyp
- durchführender Trainer
- Körpergewicht am Testtag
- Protokollvorlage und Version
- indoor oder outdoor

### 11.2 Optionale Angaben

- Raumtemperatur
- Luftfeuchtigkeit
- Höhenlage
- Schlafqualität
- subjektive Erholung
- letzte Mahlzeit und Abstand
- Koffeinaufnahme
- Trainingsbelastung der letzten 24 und 48 Stunden
- akute Beschwerden
- relevante Medikation
- Hydratationsstatus
- Laktatmessgerät
- Teststreifencharge
- Freitext

---

## 12. Sicherheitscheckliste

Vor jedem Test muss der Trainer bestätigen:

- Identität geprüft
- Einwilligung gültig
- Gerätetyp geprüft
- Testplan und Soll-Leistungsfolge geprüft
- Athlet über Ablauf und Abbruchsignal informiert
- subjektive Testbereitschaft bestätigt
- aktuell gemeldete Beschwerden abgefragt
- Messgerät und Material verfügbar
- lokale Notfall- und Abbruchprozesse bekannt
- Sensorwerte plausibel, sofern verbunden
- fachliche Verantwortung für Start und Abbruch übernommen

Während des Tests ist eine ständig sichtbare Aktion `Test sofort abbrechen` verfügbar.

Strukturierte Abbruchgründe:

- reguläre Ausbelastung
- freiwilliger Abbruch
- technische Störung
- Schmerzen oder Unwohlsein
- auffällige Herzfrequenz
- Protokollfehler
- sonstiger Grund

---

## 13. Testdurchführung

### 13.1 Geführter Ablauf

```text
Ruhewert
→ Warm-up
→ Bereitschaft
→ Belastungsstufe
→ Messpause
→ nächste Stufe
→ Testende
→ 5-Minuten-Nachbelastungsmessung
```

### 13.2 Live-Testansicht

Die Oberfläche zeigt:

- aktuelle Phase
- aktuelle Stufennummer
- Soll-Leistung
- Countdown
- nächste Soll-Leistung
- Gesamtzeit
- Verbindungsstatus
- Synchronisationsstatus
- große Eingabefelder
- akustische und visuelle Warnungen
- Pause-/Fortsetzen-Funktion
- Sofortabbruch

### 13.3 Eingabefelder je Stufe

- Soll-Leistung
- mittlere Ist-Leistung
- finale Ist-Leistung
- mittlere Herzfrequenz
- finale Herzfrequenz
- mittlere Schlag-/Trittfrequenz
- finale Schlag-/Trittfrequenz
- Stufendauer
- Distanz
- Laktat
- RPE
- tatsächlicher Probenzeitpunkt
- Bemerkung
- Abbruchgrund
- Datenquelle

### 13.4 Nachträgliche Tabellenbearbeitung

Nach Testende können Werte tabellarisch ergänzt oder korrigiert werden.

Jede Korrektur speichert:

- Ursprungswert
- neuer Wert
- Nutzer
- Zeitpunkt
- Begründung/Vermerk

---

## 14. Offline- und Synchronisationskonzept

### 14.1 Anforderungen

- Vor Teststart müssen Athlet, Protokoll und Berechtigungen geladen sein.
- Der laufende Test bleibt bei Server- oder Internetausfall nutzbar.
- Jede Änderung wird innerhalb von 500 ms in IndexedDB gespeichert.
- Wiederaufnahme nach Browser-Neustart muss möglich sein.
- Synchronisation erfolgt idempotent.
- Doppelte Stufen oder Messwerte dürfen nicht entstehen.
- Freigabe ist erst nach vollständiger Serversynchronisation möglich.

### 14.2 Statuswerte

- `ONLINE`
- `OFFLINE`
- `LOCAL_ONLY`
- `SYNC_PENDING`
- `SYNCING`
- `SYNCED`
- `SYNC_CONFLICT`
- `SYNC_FAILED`

### 14.3 Konflikte

- keine stillen Überschreibungen
- optimistische Versionskontrolle
- Konfliktansicht mit beiden Ständen
- bewusste Auswahl oder Zusammenführung durch berechtigten Trainer

### 14.4 Lokale Löschung

Lokale Testdaten werden nach erfolgreicher Synchronisation entfernt, spätestens nach 30 Tagen.

---

## 15. Bearbeitungssperren

- genau ein aktiver Bearbeiter je Test
- lesender Zugriff für andere berechtigte Nutzer
- zeitlich begrenzter Lock
- automatische Verlängerung bei Aktivität
- automatische Freigabe nach Ablauf
- kontrollierte Übernahme durch Trainer oder Tenant-Admin
- Übernahme wird auditiert
- Live-Test kann nur auf einem Gerät aktiv geführt werden

---

## 16. Bluetooth-Beta

### 16.1 Verbindlicher Umfang

- standardisierte Bluetooth-Heart-Rate-Sensoren
- Concept2 PM5 für BikeErg und RowErg
- RP3-Adapter experimentell
- keine aktive Ergometersteuerung

### 16.2 Quellenprinzip

Je Messgröße gilt genau eine aktive Quelle:

- Leistung/Kadenz
- Herzfrequenz

Kein automatischer Quellenwechsel.

Quellenwechsel:

- nur nach Bestätigung
- Zeitpunkt wird gespeichert
- betroffene Stufen werden markiert

### 16.3 Bluetooth-Daten im MVP

Es werden keine hochauflösenden Rohdaten gespeichert.

Gespeichert werden ausschließlich:

- Stufenmittelwerte
- Stufenendwerte
- Verbindungsqualität
- Datenquelle

### 16.4 Fallback

Manuelle Eingabe bleibt immer möglich und ist funktional vollständig.

---

## 17. Messwertmodell

### 17.1 Laktat

Interne Einheit: `mmol/L`

Schema:

```ts
type LactateQualifier = 'EXACT' | 'LESS_THAN' | 'GREATER_THAN';

interface LactateMeasurement {
  value: number | null;
  qualifier: LactateQualifier;
  unit: 'mmol/L';
  measuredAt: string;
  device?: string;
  stripLot?: string;
}
```

Regeln:

- Punkt und Komma als Dezimaltrennzeichen akzeptieren
- intern normalisieren
- Anzeige standardmäßig mit einer Dezimalstelle
- fehlend = `null`, niemals `0`
- Plausibilitätsbereich standardmäßig 0,5 bis 30,0 mmol/L
- außerhalb nur nach Bestätigung und Begründung

### 17.2 Qualifizierte Werte

`LESS_THAN` und `GREATER_THAN` werden:

- gespeichert
- sichtbar dargestellt
- nicht automatisch numerisch ersetzt
- standardmäßig nicht für Interpolation oder Dmax verwendet

Manuelle Schätzung ist nur mit Begründung und Audit-Eintrag zulässig.

### 17.3 Ruhe- und Nachbelastungswerte

Pro Test:

- ein Ruhewert
- genau ein Nachbelastungswert nach 5 Minuten
- tatsächlicher Messzeitpunkt wird gespeichert
- Abweichung vom Sollzeitpunkt wird markiert

---

## 18. Qualitätsstatus und Teilstufen

### 18.1 Qualitätsstatus

- `VALID`
- `PARTIAL`
- `EXCLUDED`
- `MISSING`
- `MANUALLY_CORRECTED`

### 18.2 Teilstufenregel

Eine verkürzte letzte Stufe wird automatisch einbezogen, wenn mindestens 50 % der Soll-Dauer absolviert wurden.

Unter 50 %:

- standardmäßig ausgeschlossen
- Trainer darf Entscheidung überschreiben
- Überschreibung wird dokumentiert

### 18.3 Fehlende Werte

- keine automatische Interpolation
- fixe Schwellen nur bei Einrahmung durch zwei exakte Messpunkte
- Dmax bei einer Lücke möglich, sofern mindestens vier gültige exakte Belastungswerte verbleiben
- bei mehreren Lücken Dmax standardmäßig gesperrt

---

## 19. Automatische Qualitätsprüfungen

Die App verändert Messwerte niemals automatisch.

Warnungen bei:

- Laktatabfall trotz höherer Leistung
- ungewöhnlich großem Laktatsprung
- identischen Werten über mehrere Stufen
- fehlendem Wert innerhalb der Reihe
- Herzfrequenzabfall trotz Leistungssteigerung
- Ruhewert oberhalb des ersten Belastungswertes
- LT1 oberhalb von LT2
- Dmax außerhalb plausibler Kurvenbereiche
- verkürzter Stufe
- stark abweichender Stufendauer
- abweichendem Probenzeitpunkt
- qualifizierten Messwerten
- eingeschränkter Datenbasis

Traineroptionen:

- verwenden
- ausschließen
- korrigieren
- als fehlend markieren

---

## 20. Schwellenmodelle

### 20.1 Modelle

Der MVP berechnet vier automatische Modelle:

1. fixe 2-/4-mmol-Schwellen
2. Basislaktat + 1,0 mmol/L
3. Dmax
4. modifizierte Dmax

### 20.2 Berechnungsregeln

#### Fixe 2-/4-mmol-Schwellen

- lineare Interpolation
- keine Extrapolation
- nur zwischen zwei exakten Messpunkten

#### Basiswert + 1,0 mmol/L

- Basiswert = definierter Ruhe-/Ausgangswert gemäß Algorithmusversion
- lineare Interpolation
- keine Extrapolation

#### Dmax

- kubisches Polynom über gültige Belastungsstufen
- mindestens vier gültige exakte Stufenwerte
- keine Extrapolation

#### Modifizierte Dmax

- kubisches Polynom
- versioniert definierte abweichende Start-/Endpunkte
- mindestens vier gültige exakte Stufenwerte
- keine Extrapolation

### 20.3 Persistenz je Berechnung

- Algorithmusname
- Algorithmusversion
- Eingabepunkte
- ausgeschlossene Punkte
- Koeffizienten
- Ergebnis in Watt
- interpolierte Herzfrequenz
- interpoliertes Laktat
- Güte-/Warnkennzeichen
- Berechnungszeitpunkt

Freigegebene Tests werden bei Algorithmusänderungen nicht rückwirkend neu berechnet.

### 20.4 Manuelle Trainerentscheidung

LT1 und LT2 werden getrennt festgelegt.

Der Trainer kann:

- ein automatisches Modellergebnis übernehmen
- einen manuellen Wert setzen

Eine Begründung ist verpflichtend, wenn ein manueller Wert außerhalb der Spannweite aller automatischen Modellwerte liegt.

Wenn kein automatisches Modell berechenbar ist, darf der Trainer manuell freigeben, muss aber:

- eingeschränkte Datenbasis bestätigen
- LT1 und LT2 begründen
- sichtbaren Unsicherheitshinweis akzeptieren

---

## 21. Trainingszonen

### 21.1 Drei-Zonen-Modell

- Zone 1: unter LT1
- Zone 2: LT1 bis LT2
- Zone 3: über LT2

### 21.2 Fünf-Zonen-Modell Leistung

Tenantweit versionierbare Standardregel:

| Zone | Standardgrenze |
|---|---|
| Z1 Regeneration | < 85 % LT1 |
| Z2 Grundlage | 85–100 % LT1 |
| Z3 Tempo | LT1 bis 95 % LT2 |
| Z4 Schwelle | 95–102 % LT2 |
| Z5 Hochintensiv | > 102 % LT2 |

Trainer darf pro Interpretation korrigieren. Jede Auswertung speichert die verwendete Regelversion.

### 21.3 Herzfrequenzzonen

- primär aus HF an LT1 und LT2
- Ruhe-HF ergänzt unteren Außenbereich
- bekannte oder erreichte Maximal-HF ergänzt oberen Außenbereich
- fehlt Maximal-HF, bleibt Z5 nach oben offen
- Medikamente mit HF-Einfluss erzeugen Warnhinweis
- HF-Zonen werden als sekundäre Steuerungsgröße gekennzeichnet

### 21.4 Gerätespezifität

BikeErg, RowErg und RP3 erhalten vollständig getrennte Schwellen- und Zonenprofile.

Keine automatische Übertragung zwischen Geräten.

---

## 22. Test-Lebenszyklus

```text
PLANNED
→ IN_PROGRESS
→ DATA_REVIEW
→ INTERPRETED
→ RELEASED
→ ARCHIVED
```

### 22.1 Statusdefinitionen

- `PLANNED`: Athlet, Gerät, Testplan und Checkliste vorbereitet
- `IN_PROGRESS`: Test läuft
- `DATA_REVIEW`: Daten werden geprüft
- `INTERPRETED`: LT1, LT2 und Zonen festgelegt
- `RELEASED`: Bericht für Athlet freigegeben
- `ARCHIVED`: historisch, nicht mehr aktuelles Profil

### 22.2 Unveränderlichkeit

Ein freigegebener Test ist unveränderlich.

Spätere Änderungen erzeugen:

- neue Interpretation
- neue Berichtsversion
- neue Freigabe

Ursprüngliche Daten und Versionen bleiben erhalten.

---

## 23. Freigabekriterien

Ein Test darf freigegeben werden, wenn:

- Pflicht-Stammdaten vollständig sind
- gültige Einwilligung vorliegt
- Test vollständig synchronisiert ist
- keine aktive Bearbeitungssperre besteht
- jede Stufe einen Qualitätsstatus hat
- alle Korrekturen dokumentiert sind
- kritische Warnungen bestätigt oder bearbeitet sind
- LT1 und LT2 festgelegt sind
- beide Zonenmodelle vorliegen
- Berichtsvorschau geprüft wurde
- Sprache und Berichtsversion feststehen

Kein automatisches Modell ist zwingend erforderlich, sofern die manuelle Entscheidung begründet wurde.

---

## 24. Dashboards

### 24.1 Trainer-Dashboard

Aufgabenorientiert:

- heutige geplante Tests
- laufende Tests
- nicht synchronisierte Tests
- Tests in `DATA_REVIEW`
- offene Qualitätswarnungen
- Tests ohne finale Schwellenentscheidung
- freigabebereite Berichte
- zuletzt getestete Athleten
- Suche und Filter
- Schnellaktion `Neuen Test planen`

### 24.2 Tenant-Admin-Dashboard

- Nutzer und Rollen
- Trainer-Athleten-Zuordnungen
- Teststatus im Tenant
- Backup-Status
- Update-Status
- Datenschutz- und Löschvorgänge
- Vorlagen und Zonenregeln
- Branding
- Lizenz-/Limitstatus
- optionale aggregierte Nutzungsstatistiken

### 24.3 Athleten-Dashboard

Athleten sehen für freigegebene Tests:

- LT1 und LT2
- drei und fünf Zonen
- alle vier automatischen Modelle
- Algorithmusversionen
- berücksichtigte und ausgeschlossene Punkte
- Qualitätswarnungen
- Protokollabweichungen
- Trainerentscheidung
- Begründung bei Abweichungen
- Testvergleich und Verlauf
- PDF-, CSV-, JSON- und Markdown-Exporte

---

## 25. Verlaufsanalyse

Nur intraindividuell und gerätespezifisch.

Kennzahlen:

- LT1 Watt
- LT2 Watt
- LT1 W/kg
- LT2 W/kg
- HF an LT1
- HF an LT2
- Laktat an LT1
- Laktat an LT2
- höchste vollständig absolvierte Stufe
- 5-Minuten-Nachbelastungslaktat
- Gewicht
- Trainingsumfang als Kontext

Keine tenantübergreifenden Benchmarks, Ranglisten oder Normwerte.

---

## 26. Vergleichbarkeit von Tests

### 26.1 Direkt vergleichbar

- gleicher Gerätetyp
- gleiche Protokollversion
- gleiche Stufendauer
- gleiche Messpause
- gleiches Inkrement
- vergleichbare Probenzeitpunkte
- kompatible Algorithmusversionen

### 26.2 Eingeschränkt vergleichbar

- gleicher Gerätetyp
- abweichender Startwert
- abweichendes Inkrement
- andere maximale Stufenzahl
- kleinere Abweichungen bei Pause/Probenzeit
- unterschiedliche Algorithmusversionen

### 26.3 Nicht methodisch vergleichbar

- unterschiedliche Gerätetypen
- deutlich unterschiedliche Stufendauer
- andere Testverfahren
- unzureichende Messreihe

Automatische Aussagen zur Veränderung nur bei direkter Vergleichbarkeit.

---

## 27. Diagramme

Verbindlich:

- Laktat gegen Watt
- Herzfrequenz gegen Watt
- kombinierte Darstellung mit getrennten Achsen
- Markierung LT1/LT2
- Markierung aller vier Modelle
- Kennzeichnung ausgeschlossener, korrigierter und verkürzter Stufen
- Vergleich von bis zu fünf Tests desselben Gerätetyps
- Umschaltung Watt/W/kg
- Tooltips
- Tastaturzugänglichkeit
- keine rein farbliche Unterscheidung
- druckfähige Schwarz-Weiß-Darstellung
- gleiche Skalierungslogik in Web und PDF

---

## 28. Berichte

### 28.1 PDF-Bericht

Enthält:

- Athlet
- Testdatum
- Trainer
- Tenant
- Gerätetyp
- Protokollversion
- Testbedingungen
- Ruhewert
- Stufenwerte
- Nachbelastungswert
- Qualitätskennzeichen
- Laktat-Leistungs-Kurve
- HF-Leistungs-Kurve
- vier automatische Modelle
- finale LT1-/LT2-Entscheidung
- Drei-Zonen-Modell
- Fünf-Zonen-Modell
- Vergleich mit geeignetem Vortest
- optionale Trainerkommentare
- Versionsnummer
- Freigabezeitpunkt
- Nicht-Medizinprodukt-Hinweis

### 28.2 Sprachen

- Deutsch
- Englisch

Berichtssprache wird pro Export gewählt.

---

## 29. Exporte

### 29.1 Athletenexport

- PDF
- CSV
- JSON
- Markdown
- kompakte Übertragungsansicht für Fitnessuhren

### 29.2 Anonymisierter Analyseexport

Formate:

- CSV
- JSON
- Markdown

Kein SQL- oder Datenbankexport.

Enthält:

- pseudonyme Test-ID
- tenantbezogene pseudonyme Athleten-ID
- Gerätetyp
- Testzeitraum Jahr/Quartal
- Protokollversion
- Stufenwerte
- Qualitätskennzeichen
- automatische Modelle
- finale Schwellen und Zonen
- Algorithmusversionen
- Alter in 5-Jahres-Gruppen
- Masters-Klasse
- physiologische Referenzkategorie
- Gewicht in 5-kg-Klassen
- Größe in 5-cm-Klassen
- Trainingsstatus
- Sportart und Disziplin

Nicht enthalten:

- Name
- E-Mail
- exaktes Geburtsdatum
- Traineridentität
- Kontaktdaten
- Medikamente
- Gesundheitsnotizen
- Freitextnotizen

Seltene Merkmalskombinationen müssen gewarnt oder unterdrückt werden.

### 29.3 Markdown-Struktur

Eine Datei pro Test mit YAML-Frontmatter:

```markdown
---
schema_version: "1.0"
test_id: "anonymous-id"
athlete_id: "pseudonymous-id"
device_type: "ROWERG"
test_period: "2026-Q3"
age_group: "55-59"
masters_class: "M55"
---

# Stufentest

## Testprotokoll
## Ruhewert
## Belastungsstufen
## Nachbelastungswert
## Qualitätskennzeichen
## Automatische Schwellenmodelle
## Finale Trainerentscheidung
## Trainingszonen
```

### 29.4 Vollständiger Tenant-Portabilitätsexport

Enthält:

- Nutzer und Rollen
- Zuordnungen
- Athletenprofile
- Einwilligungen
- Vorlagen und Versionen
- Tests und Messwerte
- Qualitätsstatus
- automatische Modelle
- Interpretationen
- Zonen
- Berichte
- zulässige Audit-Logs
- Branding und Einstellungen
- Manifest
- Datenwörterbuch
- Schema-Version
- Prüfsummen

Nicht enthalten:

- Passwort-Hashes
- Sessions
- Schlüssel
- Secrets

### 29.5 Tenant-Import

- Manifest- und Prüfsummenprüfung
- Schema-Prüfung
- Dry-Run
- Vorschau
- Import in neuen Tenant oder neue Installation
- Neuzuordnung technischer IDs
- Erhalt fachlicher IDs und Zeitstempel
- atomarer Import oder Rollback
- Importprotokoll
- Roundtrip-Integrationstests

### 29.6 Schutz vollständiger Exporte

- erneute Authentifizierung
- verschlüsseltes Paket
- Schlüssel getrennt übermitteln
- einmaliger Download
- zeitlich begrenzter Link
- serverseitige Löschung nach 24 Stunden
- Audit-Eintrag

---

## 30. Benachrichtigungen

### 30.1 In-App verpflichtend

- Trainerzuordnung
- geplanter Test
- nicht synchronisierter Test
- unterbrochener Test
- Datenprüfung offen
- Qualitätswarnung offen
- Interpretation offen
- Freigabe offen
- Bericht freigegeben
- Einwilligung fehlt oder widerrufen
- Backup fehlgeschlagen
- Update fehlgeschlagen
- Löschvorgang erfordert Aktion

### 30.2 E-Mail optional

Nur bei konfiguriertem SMTP oder Cloud-Versand:

- Einladungen
- Passwortreset
- Berichtfreigabe
- administrative Warnungen

Keine Push- oder SMS-Benachrichtigungen im MVP.

---

## 31. Authentifizierung

### 31.1 SaaS/Cloud

- Clerk bevorzugt
- Einladung per E-Mail
- Magic Link möglich
- keine offene Selbstregistrierung

### 31.2 Autarker Modus

- Better Auth
- E-Mail/Benutzername und Passwort
- sichere Passwort-Hashes
- lokale Einmalcodes oder Einladungslinks
- Passwortreset durch Tenant-Admin, sofern kein SMTP
- optional lokales SMTP
- keine Social Logins erforderlich

### 31.3 Grundsätze

- Auth-Provider liefert Identität
- fachliche Rollen und Tenant-Zuordnungen bleiben in eigener Datenbank führend
- reaktive Sitzungsprüfung
- sichere Cookies
- CSRF-Schutz
- Rate Limiting

---

## 32. DSGVO und Datenschutz

### 32.1 Grundsätze

- Verarbeitung sportbezogener Gesundheitsdaten
- dokumentierte Rechtsgrundlage
- aktive Einwilligung
- Zweckbindung
- Datenminimierung
- datenschutzfreundliche Voreinstellungen
- keine Nutzung für KI-Training ohne separate Einwilligung
- Betroffenenrechte: Auskunft, Export, Berichtigung, Löschung, Einschränkung

### 32.2 Aufbewahrung

Tenantkonfigurierbar zwischen 1 und 10 Jahren.

Standard: 10 Jahre nach letztem Test.

Zusätzlich:

- offene Einladungen: 30 Tage
- verwaltete Profile ohne Testdaten: 12 Monate
- lokale Testdaten: nach Sync, spätestens 30 Tage
- Audit-Logs: gekoppelt an Fachdaten, mindestens 3 Jahre

### 32.3 Widerruf

Athlet kann wählen:

- keine neuen Tests
- keine weitere Nutzung bestehender Daten
- Löschung/Anonymisierung beantragen

Widerruf wirkt sofort als Nutzungssperre.

Tenant-Admin prüft Aufbewahrungsgründe und führt Löschung oder irreversible Anonymisierung durch.

---

## 33. Audit-Log

### 33.1 Zu protokollierende Ereignisse

- Login, fehlgeschlagener Login, Logout
- Rollenänderungen
- Trainer-Athleten-Zuordnungen
- Einwilligung und Widerruf
- Testanlage, Start, Unterbrechung, Übernahme, Abbruch
- Messwertänderungen
- Ausschluss/Wiedereinschluss
- Bluetooth-Quellenwechsel
- Schwellenberechnung
- manuelle LT1-/LT2-/Zonenfestlegung
- Freigabe und Berichtsversion
- Exporte
- Löschung und Anonymisierung
- Vorlagen- und Zonenregeländerungen
- Backup, Restore, Update und Setup
- Lock-Aufhebung

### 33.2 Audit-Datensatz

- Zeitpunkt
- Identität
- Rolle
- Tenant
- Aktion
- Entität
- alter Zustand
- neuer Zustand
- Begründung
- Auth-Provider
- Sitzungskennung
- technische Herkunft

### 33.3 Aufbewahrung

- wie Fachdaten, mindestens 3 Jahre
- direkte Identifikatoren nach Athletenlöschung pseudonymisieren
- einzelne Audit-Einträge nicht über UI löschbar

Kein generelles Logging jedes normalen Lesezugriffs.

---

## 34. Branding

Tenant-Admin kann konfigurieren:

- Organisationsname
- Logo
- barrierefrei geprüfte Akzentfarbe
- Kontaktangaben
- Impressum
- PDF-Kopfzeile
- PDF-Fußzeile
- kurzen Berichtshinweis

Nicht enthalten:

- freie Schriftarten
- tenant-spezifische Domains
- individuelles UI-Layout
- eigenes PWA-Icon
- vollständiges White-Labeling

---

## 35. Internationalisierung

- Deutsch und Englisch vollständig
- Sprache pro Nutzer
- Berichte in beiden Sprachen
- metrische Einheiten
- Eingabe mit Punkt oder Komma
- interne ISO-Zeitstempel
- Tenant-Zeitzone, Standard `Europe/Berlin`
- keine fest codierten UI-Texte

---

## 36. Barrierefreiheit

Zielstandard: WCAG 2.2 AA.

Verbindlich:

- vollständige Tastaturbedienung
- große Touch-Ziele
- ausreichende Kontraste
- Fokuszustände
- Screenreader-fähige Formulare und Tabellen
- Diagramme mit Textalternativen
- keine rein farbliche Kennzeichnung
- akustische Signale immer zusätzlich visuell
- skalierbare Schrift
- reduzierte Animationen
- verständliche Fehlermeldungen

---

## 37. PWA-Anforderungen

- installierbare PWA
- Tablet-Priorität
- responsive auf Smartphone und Desktop
- Fullscreen-Modus
- App-Symbol
- Service Worker
- lokal gecachte App-Shell
- IndexedDB
- Wiederaufnahme laufender Tests
- Wake Lock, soweit verfügbar
- keine native App im MVP

---

## 38. Deployment

### 38.1 Docker Compose Services

Mindestens:

```yaml
services:
  app:
  libsql:
  reverse-proxy:
  backup:
```

Optional:

```yaml
  smtp:
  observability:
```

### 38.2 Reverse Proxy

- Caddy oder Traefik
- HTTPS auf VPS zwingend
- HTTPS lokal, sobald mehr als `localhost`
- interne Installation kann auf Club-Netz beschränkt werden

### 38.3 Konfiguration

- Umgebungsvariablen
- Docker Secrets
- gemountete Secret-Dateien
- keine Secrets im Image oder Repository

### 38.4 Healthchecks

- Next.js App
- Identity Provider
- libSQL
- Backup-Job
- Migrationstatus

---

## 39. Lokaler Setup-Assistent

Einmalig nach erstem Start.

Erfasst:

- Clubname
- Zeitzone
- Sprache
- Einheiten
- ersten Tenant-Admin
- Passwortregeln
- Aufbewahrungsfrist
- Basis-URL
- optional SMTP
- Backup-Ziel
- Datenschutz-Grundeinstellungen

Nach Abschluss dauerhaft gesperrt.

Reset nur per dokumentiertem CLI-Befehl.

---

## 40. Backup und Restore

### 40.1 Backup

- täglich
- verschlüsselt
- Standardaufbewahrung 30 Sicherungen
- lokales Verzeichnis oder NAS
- optional S3-kompatibler Speicher
- manuell vor Updates
- Integritätsprüfung
- Status im Admin-Dashboard

### 40.2 Restore

- dokumentierter CLI-Workflow
- Prüfung von Manifest und Integrität
- Restore in Wartungsmodus
- Healthchecks nach Wiederherstellung

### 40.3 Ziele

- reguläres RPO: höchstens 24 Stunden
- RPO laufender Test: nahezu null durch IndexedDB
- RTO: 4 Stunden

---

## 41. Updates

### 41.1 Online

- versionierte Docker-Images
- Registry
- Release Notes
- kontrollierte Migrationen

### 41.2 Offline

Signiertes Paket mit:

- Docker-Images
- Manifest
- Prüfsummen
- Signatur
- Migrationen
- Release Notes

### 41.3 Updateablauf

1. Update auswählen
2. Release Notes anzeigen
3. Backup erstellen und prüfen
4. Images laden/importieren
5. Migrationen ausführen
6. Healthchecks
7. Erfolg protokollieren
8. bei Fehler dokumentierter Restore

Keine unbeaufsichtigten Auto-Updates.

---

## 42. Sicherheit

- TLS/HTTPS
- sichere Cookies
- CSRF-Schutz
- Content Security Policy
- Rate Limiting
- sichere Passwort-Hashes
- Secrets außerhalb des Codes
- verschlüsselte Backups
- verschlüsselte Datenträger/Volumes als Betriebsvorgabe
- keine sensiblen Daten in Logs
- Schlüsselrotation
- keine vollständige Feldverschlüsselung der Diagnostikdaten im MVP

---

## 43. Support-Export

### 43.1 Standardexport

Ohne Athleten- und Diagnostikdaten:

- App-Version
- Schema-Version
- Deployment-Modus
- Containerstatus
- Healthchecks
- Fehlercodes
- Migrationsstatus
- Backupstatus
- Auth-Provider
- Datenbanktyp
- Browser-/PWA-/Bluetooth-Kompatibilität
- Synchronisationsfehler ohne Messwerte
- Konfiguration ohne Secrets
- Korrelations-IDs

### 43.2 Erweiterter Supportexport

Nur nach ausdrücklicher Auswahl durch Tenant-Admin:

- pseudonymisierte Testdaten eines konkreten Supportfalls
- vollständige Vorschau vor Export

---

## 44. Lizenz- und Feature-Struktur

Keine Zahlungsabwicklung.

Vorbereitet werden:

- `TRIAL`
- `ACTIVE`
- `SUSPENDED`
- Limits für Trainer
- Limits für Athleten
- Limits für Tests
- Feature Flags

Lokaler Club-Modus:

- keine verpflichtende Online-Lizenzprüfung

Bei Lizenzablauf:

- schreibgeschützter Zugriff
- vollständiger Export bleibt möglich
- keine Datenlöschung

---

## 45. Datenmodell — Kernentitäten

### 45.1 Identität und Tenant

- `tenants`
- `users`
- `user_identities`
- `tenant_memberships`
- `roles`
- `invitations`

### 45.2 Athleten

- `athletes`
- `athlete_snapshots`
- `coach_athlete_assignments`
- `consents`
- `guardian_consents`
- `athlete_context_updates`

### 45.3 Protokolle

- `protocol_templates`
- `protocol_template_versions`
- `zone_rule_sets`
- `zone_rule_versions`

### 45.4 Tests

- `tests`
- `test_plan_snapshots`
- `test_condition_snapshots`
- `test_stages`
- `rest_measurements`
- `recovery_measurements`
- `test_locks`
- `sync_sessions`

### 45.5 Diagnostik

- `quality_flags`
- `measurement_corrections`
- `measurement_exclusions`
- `threshold_runs`
- `threshold_results`
- `interpretations`
- `zone_profiles`
- `report_versions`

### 45.6 Betrieb

- `audit_events`
- `notifications`
- `exports`
- `imports`
- `backup_runs`
- `update_runs`
- `feature_flags`
- `license_state`

---

## 46. Datenmodell — zentrale Constraints

- jede fachliche Tabelle enthält `tenant_id`
- alle UUIDs serverseitig erzeugen
- fachliche IDs und technische IDs trennen
- freigegebene Datensätze immutable
- Versionstabellen statt Überschreiben
- `deleted_at` nur für Soft-Delete-Workflows, nicht als Ersatz für echte DSGVO-Löschung
- Audit-Log append-only
- keine Cross-Tenant-FKs
- Testgerätetyp als Enum: `BIKEERG`, `ROWERG`, `RP3`
- Teststatus als Enum
- Datenquelle als Enum: `MANUAL`, `BLUETOOTH`, `SYSTEM_DERIVED`

---

## 47. API- und Autorisierungsprinzipien

- alle schreibenden Vorgänge serverseitig
- jede Mutation prüft Session, Tenant und Rolle
- keine `tenant_id` aus Client-Eingaben vertrauen
- Tenant immer aus autorisierter Session ableiten
- idempotente Mutationen für Offline-Sync
- Versionsnummern für optimistische Sperren
- Zod-Validierung an allen Grenzen
- keine Extrapolation oder stille Datenkorrektur im Backend

Beispiel:

```ts
async function updateStage(input: UpdateStageInput, session: Session) {
  const authz = await authorize(session, {
    action: 'test.stage.update',
    testId: input.testId,
  });

  return db.transaction(async (tx) => {
    await assertVersion(tx, input.stageId, input.expectedVersion);
    const result = await persistStageUpdate(tx, authz.tenantId, input);
    await appendAuditEvent(tx, buildStageAuditEvent(session, input, result));
    return result;
  });
}
```

---

## 48. Algorithmusvalidierung

Verbindlich:

- deterministische Unit-Tests
- Referenzdatensätze
- erwartete LT1-/LT2-Ergebnisse
- Grenzfälle
- Property-based Tests
- Gegenrechnung in Python oder R
- neue Algorithmusversion bei fachlicher Änderung
- Regressionstests
- Golden-Master-Tests für PDF und Exporte
- End-to-End-Test von Planung bis Freigabe

---

## 49. Tenant-Isolationstests

Für jede Rolle automatisiert prüfen:

- fremde Tenant-Daten nicht lesbar
- fremde Tenant-Daten nicht änderbar
- fremde IDs führen nicht zu Datenleck
- Exporte enthalten nur eigenen Tenant
- Locks und Benachrichtigungen bleiben tenantgebunden
- Audit-Log bleibt tenantgebunden
- Plattform-Admin sieht keine Diagnostikdaten ohne expliziten Supportprozess

---

## 50. Leistungs- und Kapazitätsziele

- bis 2.000 Athleten je Tenant
- bis 100 Trainer je Tenant
- mindestens 20 gleichzeitig aktive Nutzer
- bis 10 parallel laufende Tests
- typische Seitenaufrufe unter 2 Sekunden
- lokale Eingabereaktion unter 100 ms
- IndexedDB-Persistenz unter 500 ms
- PDF-Erzeugung gewöhnlich unter 10 Sekunden
- keine doppelten Messwerte bei Retry
- Wiederaufnahme nach Browser-Neustart

---

## 51. Beobachtbarkeit

- strukturierte Logs
- Korrelations-ID je Request und Sync-Vorgang
- keine Diagnostikwerte in Standardlogs
- Health-Endpunkte
- Migrationsstatus
- Backupstatus
- Synchronisationsmetriken
- Bluetooth-Fehlercodes ohne personenbezogene Daten
- optional OpenTelemetry

---

## 52. Abnahmekriterien MVP

### 52.1 Tenant und Rollen

- [ ] SaaS-Modus unterstützt mehrere Tenants.
- [ ] Lokaler Modus unterstützt exakt einen Tenant.
- [ ] Rollenmatrix ist vollständig umgesetzt.
- [ ] Athlet kann mehreren Trainern zugeordnet werden.
- [ ] Tenant-Isolationstests bestehen.

### 52.2 Testplanung

- [ ] Drei Werksvorlagen vorhanden.
- [ ] Tenant-Admin kann versionierte Varianten anlegen.
- [ ] Testplanung aus erwarteter LT2 funktioniert.
- [ ] Startwert, Inkrement und maximale Stufenzahl sind anpassbar.
- [ ] Testplan-Snapshot ist nach Start unveränderlich.

### 52.3 Testdurchführung

- [ ] Geführter Timerworkflow vollständig.
- [ ] Akustische und visuelle Warnungen.
- [ ] Sofortabbruch jederzeit möglich.
- [ ] Ruhewert und 5-Minuten-Wert erfassbar.
- [ ] Nachträgliche Tabellenbearbeitung vorhanden.

### 52.4 Offline

- [ ] Eingaben werden lokal gespeichert.
- [ ] Test nach Browser-Neustart wiederaufnehmbar.
- [ ] Offline-Durchführung möglich.
- [ ] Sync idempotent.
- [ ] Konflikte werden sichtbar aufgelöst.

### 52.5 Diagnostik

- [ ] Vier Modelle implementiert.
- [ ] Kubisches Dmax versioniert.
- [ ] Keine Extrapolation.
- [ ] Teilstufenregel ab 50 %.
- [ ] Fehlende und qualifizierte Werte konservativ behandelt.
- [ ] Manuelle Trainerentscheidung möglich.
- [ ] Drei- und Fünf-Zonen-Modell vorhanden.

### 52.6 Berichte und Exporte

- [ ] PDF Deutsch/Englisch.
- [ ] CSV, JSON und Markdown.
- [ ] Anonymisierter Analyseexport.
- [ ] Vollständiger Tenant-Export.
- [ ] Import mit Dry-Run und Rollback.
- [ ] Exporte verschlüsselt und auditiert.

### 52.7 Datenschutz

- [ ] Einwilligungsworkflow.
- [ ] Widerruf und Nutzungssperre.
- [ ] Löschung/Anonymisierung.
- [ ] Minderjährigenworkflow.
- [ ] Aufbewahrungsfristen.
- [ ] Audit-Log append-only.

### 52.8 Deployment

- [ ] Docker-Compose-Deployment.
- [ ] lokaler libSQL-Container.
- [ ] Better Auth autark.
- [ ] Clerk optional im SaaS-Modus.
- [ ] Setup-Assistent.
- [ ] tägliche verschlüsselte Backups.
- [ ] Online- und Offline-Updates.
- [ ] Restore-Dokumentation.

### 52.9 UX und Qualität

- [ ] PWA installierbar.
- [ ] Tablet-Priorität.
- [ ] WCAG 2.2 AA.
- [ ] Deutsch und Englisch.
- [ ] 10 parallele Tests ohne Funktionsverlust.

---

## 53. Empfohlene Implementierungsreihenfolge

### Phase 1 — Fundament

- Monorepo/Projektstruktur
- Next.js, TypeScript, Drizzle, libSQL
- Better Auth lokal
- Tenant- und Rollenmodell
- Setup-Assistent
- Docker Compose

### Phase 2 — Athleten und Protokolle

- Athletenprofile
- Trainerzuordnungen
- Einwilligungen
- Minderjährigenworkflow
- Vorlagen und Versionierung
- Testplanung aus erwarteter LT2

### Phase 3 — Testdurchführung

- Timerworkflow
- IndexedDB
- Offline-Sync
- Locks
- manuelle Messwerterfassung
- Qualitätsstatus

### Phase 4 — Diagnostischer Fachkern

- Interpolation
- fixe 2-/4-mmol-Schwellen
- Basis +1 mmol/L
- Dmax
- modifizierte Dmax
- Trainerentscheidung
- Zonenmodelle

### Phase 5 — Berichte und Dashboards

- Trainer-Dashboard
- Athleten-Dashboard
- Diagramme
- PDF
- CSV/JSON/Markdown

### Phase 6 — Datenschutz und Portabilität

- Audit
- Widerruf/Löschung
- Aufbewahrung
- Tenant-Export/-Import
- anonyme Exporte

### Phase 7 — Bluetooth-Beta

- HR-Profil
- Concept2 PM5
- Quellenzuordnung
- Reconnect
- RP3 experimentell

### Phase 8 — Betrieb

- Backup/Restore
- Updateworkflow
- Offline-Updatepakete
- Supportexport
- Observability
- Last- und Isolationstests

---

## 54. Offene technische Detailentscheidungen für die Umsetzung

Diese Punkte sind keine Produktblocker und können im Architektur- oder Implementierungs-ADR entschieden werden:

1. konkrete Chartbibliothek
2. konkrete PDF-Rendering-Lösung
3. Caddy versus Traefik
4. genauer libSQL-Server-Container
5. Monorepo versus Single-App-Repository
6. konkrete Signaturtechnik für Offline-Updatepakete
7. konkrete Verschlüsselung des Export-/Backuppakets
8. exakte modifizierte-Dmax-Definition und Referenzliteratur
9. PM5-GATT-Mapping je Firmwarestand
10. konkrete k-Anonymitäts-/Seltenheitsregel für Analyseexporte

---

## 55. Definition of Done

Der Diagnostik-MVP gilt als fertig, wenn ein Trainer in einer vollständig autarken lokalen Installation und in einer SaaS-Installation:

1. einen Athleten anlegen oder einladen kann,
2. einen wattbasierten Test aus einer versionierten Vorlage planen kann,
3. den Test timergeführt und auch bei Serverausfall durchführen kann,
4. Ruhe-, Stufen- und Nachbelastungswerte erfassen kann,
5. Qualitätsprobleme nachvollziehbar behandeln kann,
6. vier automatische Schwellenmodelle berechnen kann,
7. LT1, LT2 und beide Zonenmodelle freigeben kann,
8. einen unveränderlichen zweisprachigen Bericht erzeugen kann,
9. Ergebnisse vollständig und anonymisiert exportieren kann,
10. den gesamten Tenant exportieren und in einer neuen Installation validiert importieren kann,
11. alle relevanten Änderungen revisionssicher nachvollziehen kann,
12. die Anwendung DSGVO-konform, gesichert, gesichert wiederherstellbar und ohne externe Cloud-Dienste betreiben kann.

