# DESIGN.md — Masters Diagnostics

## Brand profile

This application uses the canonical Skillz `sport-performance` brand profile (`skills/frontend-design-system-context/references/brand-profiles/sport-performance.json`). The profile is the binding visual color standard for Sport applications unless a higher-priority corporate profile such as EUROIMMUN applies.

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

Canonical values must not be locally replaced by framework, template or arbitrary project colors. Derived UI colors are allowed only when their source token and purpose remain traceable.

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

## Shared Sport Performance brand family

Masters Diagnostics and Sport Athlete Management are related products, not identical brands. They therefore share a common visual grammar while using product-specific marks.

The family rules are binding:

- same canonical `sport-performance` palette;
- same visual weight, geometric discipline and line/stroke language;
- same system-first geometric sans typography;
- same icon construction logic and corner/radius character;
- logo, favicon and app icon are derived from one product mark, not designed independently;
- product identity comes from the central symbol and emphasis, not from introducing unrelated colors;
- the two product marks must remain clearly distinguishable at favicon size.

### Masters Diagnostics mark

The Masters Diagnostics mark represents **measurement, diagnostics and performance interpretation**. The preferred concept combines:

- a strong circular or partial-ring frame in Sport Navy as the shared family anchor;
- rising metric/data bars in Teal/Bright Teal;
- a compact diagnostic/performance curve or pulse line using the Energy accent;
- simplified geometry that remains legible at 32 px.

The mark must communicate at least these project properties: **diagnostics/data**, **performance progression**, and **clinical/technical reliability**. Avoid medical-cross clichés, generic heart icons, framework logos and decorative fitness silhouettes.

### Wordmark and lockup

- Product name: `Masters Diagnostics`.
- Wordmark uses the shared Sport Performance typographic family and Navy/Dark text.
- The symbol may be used alone for favicon/app-icon contexts.
- Horizontal and stacked lockups must preserve the same symbol proportions.

### Favicon

The favicon is a simplified version of the same circular diagnostics mark. It keeps the Navy frame and only the minimum Teal + Energy diagnostic geometry required for recognition. No separate favicon artwork or unrelated monogram is allowed.

### App icon

The app icon uses the same mark centered on a high-contrast Sport Performance field, preferably Navy/Dark with light mark elements or a White/Surface field with the canonical Navy/Teal/Energy symbol. Platform-specific masking may alter the outer container, but not the internal brand geometry.

## Accessibility and data visualization

- WCAG AA is the minimum target for normal text.
- Approved dark filled states use white foreground according to the canonical profile.
- Focus must remain visible on keyboard navigation.
- Status and interpretation must include text, labels, markers, symbols or line styles; meaning must never be encoded by color alone.
- Charts use the canonical order: Navy, Bright Teal, Energy, Critical, Recovery, Success.
- Critical red is reserved for genuine stop/risk/injury states.
- Recovery violet is reserved for recovery/readiness or a documented secondary analytic dimension.
- Reduced-motion preferences are respected.

## Brand assets

Logo, favicon and app icon must form one coherent Sport Performance brand family and use the same canonical color system. The Masters Diagnostics assets must implement the diagnostics/data/curve concept above and stay visibly related to, but distinct from, the Sport Athlete Management assets.

Required asset set when branding is implemented:

- primary logo/lockup;
- standalone product mark;
- favicon at browser-relevant sizes;
- installable-app/PWA icon set;
- source vector artwork where practical;
- raster exports derived from the same source geometry.

No unrelated framework/default-color iconography may be introduced.

## Review gate

A UI or brand change is acceptable only when canonical token values are intact, semantic roles are respected, foreground/background contrast is AA-compatible, charts do not rely on color alone, no template/framework colors silently override the Sport Performance profile, and logo/favicon/app-icon remain one coherent product-specific member of the shared Sport family.


## Implemented brand asset registry

The product-specific Masters Diagnostics identity is implemented and derived from one canonical vector geometry.

- `apps/web/public/brand/mark.svg` — standalone diagnostics mark with ring, measurement bars and performance curve.
- `apps/web/public/brand/app-icon.svg` — high-contrast app-icon source.
- `apps/web/public/brand/logo-lockup.svg` / `logo-lockup.png` — primary horizontal lockup.
- `apps/web/public/favicon.svg` / `favicon-32.png` — browser identity.
- `apps/web/public/icons/app-icon-192.png`, `app-icon-512.png`, `app-icon-1024.png` — installable-app derivatives.
- `apps/web/public/manifest.webmanifest` — canonical PWA registration using Sport Navy `#173652`.

All raster files are derivatives of the SVG masters. Do not redraw favicon or app icons independently; regenerate them from these sources.
