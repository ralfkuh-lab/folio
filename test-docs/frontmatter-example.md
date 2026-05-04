---
title: Login-Service Spec
author: Ralf Kuhlendahl
date: 2026-04-29
status: review
tags: [security, draft, auth]
reviewer: "team-backend"
---

# Login-Service Spec

Diese Datei testet die Frontmatter-Anzeige. Oberhalb dieses Headings sollte
eine kleine Metadaten-Box erscheinen mit den YAML-Werten als Key/Value-Liste.

## Erwartetes Verhalten

- Box mit dezentem Hintergrund, Border, kleinerer Schrift.
- Listen wie `tags: [security, draft, auth]` werden komma-separiert dargestellt.
- Strings in Anfuehrungszeichen (`"team-backend"`) werden ohne die Quotes
  angezeigt.
- Wenn ein Dokument keinen `---`-Block am Anfang hat, erscheint keine Box.

## Sanity-Check

Die TOC-Pane darf keine YAML-Zeilen als Headings auflisten — sie soll nur
**Erwartetes Verhalten** und **Sanity-Check** zeigen.
