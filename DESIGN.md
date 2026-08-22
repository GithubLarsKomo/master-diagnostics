# DESIGN.md — Masters Diagnostics

## Direction

**Performance laboratory console.** The interface should feel like a modern diagnostic workstation: dark technical chrome, calm light work surfaces, precise typography, strong numeric hierarchy and restrained semantic color. It must look intentional without becoming decorative.

This is an evolution of the current UI, not a redesign for its own sake.

## Shared family

Masters Diagnostics and `sport-athlete-management-app` share the same design grammar:

- deep pine/charcoal application chrome;
- warm neutral work surface;
- system-first geometric sans typography;
- compact spacing and high information density;
- large radius only for major surfaces, smaller radius for controls;
- semantic status colors with text labels, never color alone;
- subtle borders and shadows rather than glassmorphism;
- minimal motion, limited to focus/hover/loading feedback.

Product identity may differ through accent color and information hierarchy.

## Masters identity

Masters uses a **cool mint/teal accent** to signal measurement and diagnostic operations.

### Core tokens

```css
--md-bg: #edf1ef;
--md-surface: #ffffff;
--md-surface-subtle: #f5f7f6;
--md-chrome: #10231d;
--md-chrome-2: #173128;
--md-text: #12211c;
--md-text-muted: #66746f;
--md-border: #d7dfdb;
--md-border-strong: #b8c6c0;
--md-accent: #2f7f65;
--md-accent-strong: #215f4c;
--md-accent-soft: #dff1e9;
--md-focus: #68b89b;
--md-warning: #8a6500;
--md-warning-soft: #fff2c7;
--md-danger: #9f2c2c;
--md-danger-soft: #ffdede;
--md-success: #17603a;
--md-success-soft: #ddf2e5;
```

## Typography

Use the native/system stack so the app is reliable offline and has no external font dependency.

```css
font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

- Page titles: compact, heavy, `clamp()` based.
- Section titles: 1.1–1.5rem, 750–800 weight.
- Eyebrows: 0.72rem, uppercase, 0.12–0.15em tracking.
- Numbers/timers: tabular numerals, high weight, no decorative type.
- Body copy: 0.9–1rem, line-height ~1.5.

## Layout

### Application chrome

Use a persistent top header for product identity, signed-in identity/role and a small number of global actions. The header is not a marketing hero.

### Content shell

- max width: 1180–1240px;
- desktop horizontal padding: 24–32px;
- mobile horizontal padding: 12–16px;
- vertical rhythm: 16 / 20 / 28 / 40px.

### Surfaces

Do not default every concept to an identical card. Use:

- **primary work surface** for the current task;
- **compact panels** for secondary context;
- **tables/lists** for repeated operational items;
- **status strips** for safety/connectivity/warnings;
- cards only where a self-contained object truly benefits from a bounded surface.

## Dashboard hierarchy

The dashboard should prioritize:

1. next trainer tasks;
2. active/running tests;
3. items waiting for data review/release;
4. direct entry to Athletes and Tests;
5. administrative/system explanation last.

Do not lead with generic metric tiles if a task list communicates the same information more directly.

## Live test

- Timer is the dominant element.
- Current stage, target load, elapsed/remaining time and sampling window must be visible without scrolling on common tablet sizes.
- Critical stop/abort action is visually separated from routine actions.
- Connectivity state is persistent but visually quiet until degraded.
- Warning states use icon/text + semantic background/border, not color alone.

## Forms

- labels above controls;
- min control height 44px, preferably 46–48px on live/test-floor flows;
- helper text below the relevant field;
- grouped fields separated by whitespace rather than excessive borders;
- validation messages remain close to the field or action.

## Buttons

- primary: filled accent, one clear action per local surface;
- secondary: neutral surface + border;
- destructive: red only for genuinely destructive/irreversible actions;
- avoid multiple equally loud actions in one panel.

## Tables and review grids

- sticky or visually persistent headers where practical;
- horizontal overflow is acceptable for diagnostic review if every column is necessary;
- row hover/focus should aid tracking, not decorate;
- editable cells must retain visible labels or accessible names;
- selected/excluded/warning states need text/icon semantics.

## Accessibility

- WCAG AA contrast target for normal text;
- visible `:focus-visible` treatment on all controls and links;
- never communicate GREEN/YELLOW/RED solely via color;
- touch targets >= 44px in athlete/test-floor interactions;
- reduced-motion preference respected;
- native semantic elements preferred over custom click targets.

## Motion

Use only short functional transitions (roughly 120–180ms) for hover, focus, expand/collapse or state confirmation. No decorative entrance sequences, parallax or ambient motion.

## Anti-patterns

Reject:

- generic equal-weight card grids;
- gradient text;
- decorative glassmorphism;
- giant marketing-style hero sections inside the app;
- arbitrary stock/generated illustrations;
- modal-first workflow design;
- excessive pills/badges where plain text is clearer;
- hidden critical controls for the sake of visual cleanliness.

## Review checklist

A surface is ready when:

- the primary task is visually obvious within seconds;
- information density is appropriate for an expert operator;
- status/version/provenance are visible where decisions depend on them;
- mobile/tablet behavior is deliberate;
- keyboard focus and contrast are correct;
- visual elements have a functional reason;
- the surface does not look like a generic dashboard template.
