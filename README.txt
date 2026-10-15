ShiftTakt Leitstand v1
======================

Zweck
- Desktop-Webanwendung für ShiftTakt Maintenance-Leitung.
- Nutzt dasselbe Supabase-Projekt und dieselben st_-Daten wie die iOS-App.
- Keine Änderungen an Build 27 / App-Store-Review erforderlich.

Login
- Sichtbarer Benutzername: Leitung Maintenance
- Internes Supabase-Konto: leitung.maintenance@shifttakt.example
- Das Passwort wird NICHT in den Webdateien gespeichert.

Enthalten
- Übersicht / Mindestbesetzung / Qualifikationswarnungen
- Monats-Schichtplan mit direkter Bearbeitung
- Jahresplan-Assistent mit drei Vorschlägen
- Team-/Mitarbeiterverwaltung inkl. Qualifikationen
- Urlaub, Krankheit, Lehrgang und sonstige Abwesenheiten
- Bereitschaftsplanung
- Abteilungen und Mindestbesetzungen
- Benutzer, Rollen und Einladungscodes
- CSV-Export und Browser-PDF/Druck
- Automatische Prüfung auf Cloud-Änderungen
- Revisionssicheres Speichern über st_save_document

Sync-Schutz
Jede Änderung lädt zuerst die aktuellste Cloud-Revision, wendet nur die konkrete
Änderung darauf an und speichert mit p_expected_revision. Bei revision_conflict
wird automatisch neu geladen und erneut versucht. Dadurch bleiben unabhängige
Änderungen anderer Geräte erhalten.

GitHub Pages
Die Dateien können als Ordner "shifttakt" in das bestehende Pages-Repository
markusrittmann-cmyk/markusrittmann-cmyk.github.io gelegt werden.
Danach lautet die URL voraussichtlich:
https://markusrittmann-cmyk.github.io/shifttakt/

Dateien
- index.html
- app.css
- app.js
- config.js
- assets/shifttakt-icon.png
- assets/helper_mascot.png
