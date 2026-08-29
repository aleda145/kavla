# Kavla Style Guide

Kavla features a distinct "Neo-Brutalist" or "Pop" aesthetic characterized by high contrast, bold borders, hard shadows, vibrant accent colors, and playful animations.

---

## Design Philosophy

- **Bold & Playful**: Thick borders and hard shadows are signature elements.
- **High Contrast**: Primary UI elements are black and white, punctuated by vibrant accent colors.
- **Tactile**: Interactions should feel physical (buttons pressing down, tooltips moving).
- **Messy yet Structured**: Embrace the "messy middle" of analytics.

## Global Colors

- **Yellow**: `bg-yellow-300` / `#fde047` - SQL, Data Tools, Highlights.
- **Green**: `bg-green-100` / `#dcfce7` - Infinite Canvas badges.
- **Violet**: `bg-violet-300` / `#c4b5fd` - **Strictly** for Kavla Branding elements only.
- **Blue**: `bg-blue-100` / `#dbeafe` - Product headers (DataSource).
- **Pink**: `bg-pink-100` / `#fce7f3` - Product headers (Chart).

---

## Canvas Style

**Context:** Tldraw shapes, `tldraw-sync-cloudflare/src`.
**Philosophy:** Content first. UI elements inside the canvas are "tools" and should be slightly more restrained than the marketing pages to avoid overwhelming the user's data.

### Containers (Shape Nodes)

Shapes on the canvas (like `DataSource`, `Chart`) use a solid container style:

- **Border**: `4px solid #000` (Thicker than web elements).
- **Radius**: `12px` (`borderRadius: 12`).
- **Shadow**: Generally **None** on the main container (the shape itself is the object).
- **Background**: White (`#fff`).

### Headers (Node Titles)

Nodes often have a distinct header bar:

- **Border**: `border-bottom: 4px solid #000`.
- **Spacing**: `padding: 8px 12px`.
- **Typography**: `font-weight: 800`, `uppercase`.
- **Colors**:
  - `DataSource`: `#dbeafe` (Blue 100)
  - `Chart`: `#fce7f3` (Pink 100)

### Internal UI (Buttons & Controls)

Buttons _inside_ nodes (e.g. "Edit", "OK") differ from Web buttons. They are "Quieter".

- **Default**: `border-2 border-black`, `shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)]` (Light/Transparent shadow).
- **Hover**: `shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]` (Becomes solid black).
- **Active**: `translate-y-[1px]`.
- **Size**: Typically compact (`h-9`, `text-xs`).

**_Reference Implementation (React/Tailwind mix):_**

```tsx
const buttonBaseClass =
  "h-9 px-3 border-2 border-black text-black font-bold text-xs flex items-center justify-center gap-2 rounded cursor-pointer shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)] hover:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] transition-all active:translate-y-[1px]";
```

### Dropdowns / Overlays

Overlays _do_ use the "Loud" shadow to float above content:

- **Shadow**: `boxShadow: "4px 4px 0px 0px rgba(0,0,0,1)"`.
- **Border**: `2px solid #000`.

---

### Chart Style (ECharts)

Charts use a specific "Hard" Neo-Brutalism subset:

- **Palette**: 500-weight vibrant colors.
  - Primary: Violet (`#8b5cf6`)
  - Secondary: Pink (`#ec4899`), Blue (`#3b82f6`), Yellow (`#eab308`), Green (`#22c55e`)
- **Axes**:
  - Thick black lines (3px).
  - No background grid (clean).
  - Bold `Inter` font for labels.
- **Data Series**:
  - **Scatter**: Large symbols (10px) with **2px black border**.
  - **Line/Area**: Thick lines (4px), symbols with **2px black border**. No shadow on the line itself.
  - **Bar**: **No border**, solid bold color.
- **Tooltip**:
  - White card, 2px black border.
  - **Hard Shadow**: `4px 4px 0px 0px rgba(0,0,0,1)`.
