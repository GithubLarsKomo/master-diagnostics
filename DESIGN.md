# DESIGN.md — Masters Diagnostics

## Brand profile

This application uses the canonical Skillz `sport-performance` brand profile (`skills/frontend-design-system-context/references/brand-profiles/sport-performance.json`). The profile is the default for Sport projects and is authoritative unless an explicit project brand override is approved.

### Canonical brand tokens

```css
--sport-navy: #173652;
--sport-dark: #1C2B3A;
--sport-body: #24313E;
--sport-teal: #246F6C;
--sport-teal-bright: #2B8884;
--sport-muted: #6B7785;
--sport-energy: #B54708;
--sport-success: #2E7D32;
--sport-warning: #9A6500;
--sport-critical: #B42318;
--sport-recovery: #6D5BD0;
--sport-border: #D6E0E6;
--sport-surface: #EDF3F6;
--sport-surface-subtle: #F6F8F9;
--sport-warning-surface: #FFF4D6;
--sport-white: #FFFFFF;
```

Canonical values must not be locally replaced by framework or template colors. Derived UI colors are allowed only when their source token and purpose remain traceable.

## Semantic defaults

- Primary: Navy
- Secondary / info: Teal
- Accent: Energy
- Success: Success green
- Warning: Warning ochre
- Danger / stop: Critical red
- Recovery / readiness: Recovery violet
- Text: Body
- Muted text: Muted
- Background: White
- Surface: Surface
- Border: Border

`teal_bright` is primarily a chart/accent/focus color. `critical` is reserved for real risk, injury, destructive or stop states and must not be decorative.

## Product direction

Masters Diagnostics is a trainer-centered performance diagnostics workbench. It should feel clinical enough for measurement review while remaining recognizably part of the Sport product family: calm light work surfaces, navy hierarchy, teal diagnostic accents and restrained semantic state colors.

## Implemented UI contract

The web application implements the profile through reusable primitives rather than page-local styling:

- `globals.css` owns canonical tokens, typography hierarchy, spacing, cards, navigation, buttons, forms, notices, status chips, dashboard metrics, live-test hierarchy, review tables, focus states, responsive behavior and reduced-motion/high-contrast handling.
- `brand.css` owns the Masters Diagnostics brand lockup plus authentication and setup presentation.
- `data-views.css` owns diagnostic tables and chart presentation.
- `WorkspaceNav` provides the canonical Overview / Athletes / Tests navigation on primary work surfaces.
- Primary work cards use restrained white/surface backgrounds, Navy hierarchy and Teal accents; semantic colors are not decorative.
- Test states always carry a textual status label in addition to their colored marker.
- Warning and risk messages use semantic notice patterns with text; critical red remains reserved for real blocking/risk/destructive conditions.
- Live-test numerical values use tabular numerals and stronger visual hierarchy without replacing textual labels.
- Review tables remain horizontally scrollable where necessary, retain visible headers, and do not encode meaning through color alone.

New UI code should reuse these primitives before introducing another page-local pattern.

## Accessibility and data visualization

- WCAG AA is the minimum target for normal text.
- Approved dark filled states use white foreground according to the canonical profile.
- Focus must remain visible on keyboard navigation.
- Interactive targets should normally be at least 44 CSS pixels high on primary workflows.
- Status and interpretation must include text, labels, markers, symbols or line styles; meaning must never be encoded by color alone.
- Charts use the canonical order: Navy, Bright Teal, Energy, Critical, Recovery, Success.
- The primary lactate curve uses Navy for the series and Bright Teal for point markers; its exact values are also exposed in an accessible data table.
- Critical red is reserved for genuine stop/risk/injury or destructive states.
- Recovery violet is reserved for recovery/readiness or a documented secondary analytic dimension.
- Reduced-motion preferences are respected; increased-contrast preferences strengthen borders and links.
- Diagnostic tables and wide review grids must remain usable on narrow screens through controlled horizontal scrolling.

## Brand assets

The canonical Masters Diagnostics mark combines three core product properties: the `M` identifies the Masters context, the plotted curve represents diagnostic measurement, and the rising endpoint represents performance progression. The mark uses Navy, Bright Teal and the Energy accent only.

Canonical assets live in `apps/web/public/brand/`:

- `masters-diagnostics-mark.svg` — vector master mark
- `masters-diagnostics-logo.svg` — full logo lockup with the project descriptor
- `favicon-32.png` — browser favicon
- `apple-touch-icon.png` — iOS home-screen icon
- `app-icon-192.png` and `app-icon-512.png` — installable PWA icons

Logo, favicon and app icon must remain one coherent Sport Performance brand family. Do not replace them with framework/default iconography or locally recolored variants.

## Review gate

A UI change is acceptable only when canonical token values are intact, semantic roles are respected, foreground/background contrast is AA-compatible, charts do not rely on color alone, and no template/framework colors silently override the Sport Performance profile. Header, workspace navigation, authentication/setup surfaces, favicon and installable app icons must use the canonical Masters Diagnostics design system and brand assets.
