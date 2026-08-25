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

Logo, favicon and app icon must form one coherent Sport Performance brand family and use the same canonical color system. Until dedicated assets are introduced, no unrelated framework/default-color iconography should be added.

## Review gate

A UI change is acceptable only when canonical token values are intact, semantic roles are respected, foreground/background contrast is AA-compatible, charts do not rely on color alone, and no template/framework colors silently override the Sport Performance profile.
