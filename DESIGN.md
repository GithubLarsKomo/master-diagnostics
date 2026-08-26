# DESIGN.md — Masters Diagnostics

## Status and source of truth

This document is normative for Masters Diagnostics.

- Template family: `sport-performance`
- Template type: `masters-diagnostics`
- Canonical Skillz template: `frontend-design-system-context/references/design-templates/sport-performance-apps.md`
- Canonical Skillz brand profile: `frontend-design-system-context/references/brand-profiles/sport-performance.json`

The restored and accepted **Impeccable UI/CSS is the binding layout template**. The confirmed 2026-08-26 Sport Performance proposal contributes **only the Masters Diagnostics logo family and the color spectrum**. Branding work must not replace or redesign the accepted layout.

## Binding layer separation

### Layer A — Impeccable UI/CSS

The existing implementation in `apps/web/src/app/globals.css`, `brand.css` and `data-views.css` owns and preserves:

- application shell, header and workspace navigation;
- content widths and responsive breakpoints;
- cards, grids, tables, review rows, charts and forms;
- typography scale and hierarchy;
- spacing and vertical rhythm;
- radii, borders and component geometry;
- diagnostic information density and hierarchy;
- responsive/mobile behavior;
- focus, hover, loading, empty and error patterns;
- motion rules.

For branding-only work this layer is frozen. A palette, logo, favicon or app-icon task must not alter non-color CSS behavior.

### Layer B — Sport Performance branding

This layer owns only:

- canonical color tokens and semantic color roles;
- the Masters Diagnostics mark and lockup;
- favicon and PWA/app icons;
- chart/status colors where the existing component already supports semantic color;
- PWA/theme metadata.

If a task says **"only logos and colors"**, treat it literally: layout, spacing, typography, component geometry, navigation, breakpoints and information hierarchy remain unchanged or behaviorally equivalent.

## Confirmed Sport Performance spectrum

These exact values are binding:

```css
--sport-navy: #173652;
--sport-teal: #246F6C;
--sport-teal-bright: #2B8884;
--sport-energy: #B54708;
--sport-critical: #B42318;
--sport-recovery: #6D5BD0;
--sport-success: #2E7D32;
--sport-surface-0: #FFFFFF;
--sport-surface-1: #F5F7FA;
--sport-surface-2: #EEF2F7;
--sport-text-primary: #0F172A;
--sport-text-secondary: #475569;
--sport-border: #E2E8F0;
```

Compatibility aliases in the application may map to these values, but must not introduce a competing palette. `Energy` is also the warning/emphasis base where needed; `Critical` is reserved for genuine risk/stop/destructive states.

The application applies this spectrum as a **color-only token overlay** in `apps/web/src/app/sport-performance-theme.css`, loaded after the accepted Impeccable CSS. That overlay must never contain layout or component-geometry rules.

## Product direction

Masters Diagnostics is a trainer-centered performance diagnostics workbench. The accepted Impeccable implementation remains the design reference: calm analytical work surfaces, clear diagnostic hierarchy, dense but readable measurement/review views, purposeful cards/tables/charts and responsive task flows.

## Product-specific mark

The mark represents **measurement, diagnostics and performance interpretation**. It is the diagnostics/data/performance-curve member of the Sport family and remains visually related to Sport Athlete Management through geometry, stroke character and palette while staying distinct at favicon size.

Logo, favicon and app icon are derived from one product-specific vector geometry. Do not reuse the Sport Athlete Management athlete/adaptation symbol.

## Implemented brand assets

- `apps/web/public/brand/mark.svg` — standalone diagnostics mark.
- `apps/web/public/brand/app-icon.svg` — app-icon source.
- `apps/web/public/brand/logo-lockup.svg` / `logo-lockup.png` — horizontal lockup.
- `apps/web/public/favicon.svg` / `favicon-32.png` — browser identity.
- `apps/web/public/icons/app-icon-192.png`, `app-icon-512.png`, `app-icon-1024.png` — installable-app derivatives.
- `apps/web/public/manifest.webmanifest` — PWA registration using Sport Navy.

Raster assets are derivatives of the SVG masters and must not be redrawn independently.

## Semantic color rules

- Primary: Navy.
- Secondary / info: Teal.
- Focus / chart accent: Bright Teal.
- Accent / energy / warning emphasis: Energy.
- Critical / stop: Critical.
- Recovery / readiness: Recovery.
- Success: Success.
- Background: Surface 0.
- Quiet surface: Surface 1.
- Secondary surface: Surface 2.
- Text: Text Primary.
- Secondary text: Text Secondary.
- Borders: Border.

Meaning must never be encoded by color alone; status and interpretation require text, labels, markers, icons, shapes or line styles as appropriate.

## Accessibility

- WCAG AA is the minimum target for normal text and controls.
- Keyboard focus remains visible.
- Touch targets remain usable on supported mobile/tablet flows.
- Reduced-motion preferences are respected.
- Critical red is not decorative.
- Diagnostic charts and safety/status decisions remain understandable without color.

## Change policy and review gate

A branding-only change is accepted only if:

1. the exact Sport Performance spectrum remains intact;
2. current logo/favicon/app icons remain one coherent product-specific family;
3. no unintended non-color change appears in the accepted Impeccable CSS/layout;
4. header/navigation proportions, grids/cards/tables, typography, spacing and responsive behavior remain equivalent;
5. WCAG AA and no-color-only semantics remain satisfied.

Any change to Layer A requires an explicit redesign request or a separately confirmed DESIGN grilling decision. Branding work alone is not authorization for a UI redesign.
