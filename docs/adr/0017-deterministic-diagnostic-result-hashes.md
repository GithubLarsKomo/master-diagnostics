# ADR 0017: Deterministische Hashes diagnostischer Ergebnisse

## Status

Angenommen

## Kontext

Diagnostische Ergebnisse werden aus Messwerten, Algorithmusversionen, Modellgüte und Warnungen abgeleitet. Für unveränderliche Ergebnis-Snapshots, Exporte und spätere Integritätsprüfungen wird ein reproduzierbarer Fingerabdruck benötigt. Normales `JSON.stringify` ist dafür nicht ausreichend, weil die Reihenfolge von Objektschlüsseln vom Aufbau des Laufzeitobjekts abhängen kann und nicht darstellbare Werte teilweise still verworfen werden.

## Entscheidung

Der Fachkern stellt die kanonische Serialisierung `diagnostic-json-v1` und einen SHA-256-Hash bereit.

- Objektschlüssel werden auf jeder Ebene lexikografisch sortiert.
- Die Reihenfolge von Arrays bleibt fachlich relevant und wird beibehalten.
- Negative Null wird als `0` serialisiert.
- Nicht endliche Zahlen, `undefined`, Funktionen, Symbole, `bigint`, Klasseninstanzen und zyklische Strukturen werden sichtbar abgelehnt.
- Der Hash wird nicht nur über das Ergebnis, sondern über einen versionierten Umschlag gebildet: `{"canonicalization":"diagnostic-json-v1","result":...}`.
- Das Ausgabeformat lautet `sha256:<64 hexadezimale Zeichen>`.
- Die Implementierung verwendet die Web-Crypto-API und ist damit in Browsern sowie modernen Node.js-Laufzeiten einheitlich nutzbar.

## Konsequenzen

Gleichwertige JSON-Ergebnisse erzeugen unabhängig von der Reihenfolge ihrer Objektschlüssel denselben Hash. Änderungen der Array-Reihenfolge oder eines Ergebniswertes ändern den Hash. Eine spätere Änderung der Kanonisierungsregeln erfordert eine neue Versionskennung statt einer stillen Verhaltensänderung.

Dieses Inkrement definiert und testet den Hash-Vertrag. Die Speicherung des Hashes in unveränderlichen Ergebnis-Snapshots und seine Verifikation beim Lesen erfolgen separat, sobald der persistierte Ergebnisvertrag vorliegt.
