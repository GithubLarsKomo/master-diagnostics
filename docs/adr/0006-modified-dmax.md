# ADR-0006: Definition des modifizierten Dmax

- Status: accepted
- Entscheidung: 2026-08-01

## Kontext

Das modifizierte Dmax dient als mathematische Schätzung der zweiten Laktatschwelle. Vor der Implementierung müssen Startpunkt, Endpunkt, Kurvenfit, Mindestdaten und Fehlerfälle eindeutig festgelegt sein, damit TypeScript- und unabhängige Python-Gegenrechnung dasselbe Ergebnis erzeugen.

## Entscheidung

### Referenzverfahren

Wir verwenden die ursprüngliche ModDmax-Definition nach Bishop et al. (1998), aufbauend auf dem Dmax-Verfahren nach Cheng et al. (1992):

- Die Laktatkurve wird als kubisches Polynom über Intensität und Blutlaktat modelliert.
- Der Startpunkt der Referenzgeraden ist der **Messpunkt unmittelbar vor dem ersten Anstieg der Blutlaktatkonzentration um mehr als 0,4 mmol/l gegenüber dem direkt vorherigen Messpunkt**.
- Der Endpunkt der Referenzgeraden ist der letzte gültige Messpunkt des Stufentests.
- ModDmax ist der Punkt auf der kubischen Regressionskurve mit dem größten senkrechten Abstand zu dieser Referenzgeraden.
- Der Suchbereich ist auf die Intensität zwischen Start- und Endpunkt beschränkt.

### Datenvoraussetzungen

- Mindestens vier gültige, nach Intensität streng aufsteigend sortierte Stufenmessungen, damit eine kubische Regression bestimmbar ist.
- Intensitäten und Laktatwerte müssen endlich sein; Laktatwerte dürfen nicht negativ sein.
- Doppelte Intensitäten sind unzulässig.
- Für die Startpunktbestimmung muss mindestens ein aufeinanderfolgender Laktatanstieg von mehr als 0,4 mmol/l existieren.
- Der gefundene Startpunkt muss vor dem letzten Messpunkt liegen und zusammen mit dem Endpunkt einen nicht entarteten Intensitätsbereich bilden.

### Numerik und Determinismus

- Die vorhandene kubische Regression des Diagnostikpakets ist wiederzuverwenden.
- Die maximale senkrechte Distanz wird deterministisch im geschlossenen Suchintervall bestimmt.
- Bei numerisch gleichwertigen Maxima wird die niedrigere Intensität gewählt.
- Ergebnisse werden mit derselben Rundungs- und Serialisierungsstrategie wie die bestehenden diagnostischen Methoden ausgegeben.

### Fehlerfälle

Die Berechnung liefert keinen Schwellenwert, sondern einen expliziten Fehler beziehungsweise eine nicht verfügbare Ergebnisvariante, wenn:

- Datenvoraussetzungen verletzt sind,
- kein Anstieg von mehr als 0,4 mmol/l gefunden wird,
- Regression oder Distanzsuche nicht endlich lösbar sind,
- das Maximum auf einem ungültigen oder entarteten Suchbereich liegt.

Es gibt keinen stillen Rückfall auf gewöhnliches Dmax, fixe Schwellen oder eine andere Methode.

## Verifikation

Die Implementierung benötigt vor Abschluss:

1. TypeScript-Unit-Tests für Startpunktwahl, Grenzfälle und deterministische Tie-Breaks.
2. Mindestens einen klinisch plausiblen und einen problematischen versionierten Referenzdatensatz.
3. Eine unabhängige Python-Gegenrechnung ohne Wiederverwendung des TypeScript-Codes.
4. Bytegenaue Reproduzierbarkeit der Referenzdateien in CI.

## Quellen

- Cheng B, Kuipers H, Snyder AC, Keizer HA, Jeukendrup A, Hesselink M. A new approach for the determination of ventilatory and lactate thresholds. Int J Sports Med. 1992;13(7):518-522. DOI: 10.1055/s-2007-1021309.
- Bishop D, Jenkins DG, Mackinnon LT. The relationship between plasma lactate parameters, Wpeak and 1-h cycling performance in women. Med Sci Sports Exerc. 1998;30(8):1270-1275.
- Chalmers S, Esterman A, Eston R, Norton K. Standardization of the Dmax method for calculating the second lactate threshold. Int J Sports Physiol Perform. 2015;10(7):921-926. DOI: 10.1123/ijspp.2014-0537.

## Folgen

Die Implementierung kann nun als separates, testgetriebenes Inkrement erfolgen. Varianten, die den Startpunkt anders definieren, sind nicht Teil von `modified-dmax-v1` und benötigen einen eigenen versionierten Methodenvertrag.