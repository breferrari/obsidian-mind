---
name: excalidraw-diagram
description: Generate Excalidraw diagrams from text content. Supports three output modes - Obsidian (.md), Standard (.excalidraw), and Animated (.excalidraw with animation order). Triggers on "Excalidraw", "diagram", "standard excalidraw", "animate".
metadata:
  version: 1.2.1
---

# Excalidraw Diagram Generator

Create Excalidraw diagrams from text content with multiple output formats.

## Output Modes

Select output mode based on the user's trigger words:

| Trigger Words | Output Mode | File Format | Use Case |
|---------------|-------------|-------------|----------|
| `Excalidraw`, `diagram`, `flowchart`, `mind map` | **Obsidian** (default) | `.md` | Open directly in Obsidian |
| `standard excalidraw` | **Standard** | `.excalidraw` | Open/edit/share on excalidraw.com |
| `animate`, `animated excalidraw` | **Animated** | `.excalidraw` | Drag to excalidraw-animate to generate animation |

## Workflow

1. **Detect output mode** from trigger words (see Output Modes table above)
2. Analyze content - identify concepts, relationships, hierarchy
3. Choose diagram type (see Diagram Types below)
4. Generate Excalidraw JSON (add animation order if Animated mode)
5. Output in correct format based on mode
6. **Automatically save to current working directory**
7. Notify user with file path and usage instructions

## Output Formats

### Mode 1: Obsidian Format (Default)

**Output strictly in the following structure, with no modifications:**

```markdown
---
excalidraw-plugin: parsed
tags: [excalidraw]
---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'

# Excalidraw Data

## Text Elements
%%
## Drawing
\`\`\`json
{complete JSON data}
\`\`\`
%%
```

**Key points:**
- Frontmatter must include `tags: [excalidraw]`
- Warning message must be included in full
- JSON must be wrapped in `%%` markers
- No `excalidraw-*` plugin settings in frontmatter other than `excalidraw-plugin: parsed` (the `tags: [excalidraw]` entry above is separate and still required)
- **File extension**: `.md`

### Mode 2: Standard Excalidraw Format

Output pure JSON file, openable on excalidraw.com:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [...],
  "appState": {
    "gridSize": null,
    "viewBackgroundColor": "#ffffff"
  },
  "files": {}
}
```

**Key points:**
- `source` uses `https://excalidraw.com` (not the Obsidian plugin)
- Pure JSON, no Markdown wrapping
- **File extension**: `.excalidraw`

### Mode 3: Animated Excalidraw Format

Same as Standard format, but each element adds a `customData.animate` field to control animation order:

```json
{
  "id": "element-1",
  "type": "rectangle",
  "customData": {
    "animate": {
      "order": 1,
      "duration": 500
    }
  },
  ...other standard fields
}
```

**Animation order rules:**
- `order`: Playback order (1, 2, 3...) — lower numbers appear first
- `duration`: Drawing duration for the element (milliseconds), default 500
- Elements with the same `order` appear simultaneously
- Recommended order: title → main framework → connection lines → detail text

**Usage:**
1. Generate the `.excalidraw` file
2. Drag to https://dai-shi.github.io/excalidraw-animate/
3. Click Animate to preview, then export as SVG or WebM

**File extension**: `.excalidraw`

---

## Diagram Types & Selection Guide

Choose the appropriate diagram type to maximize clarity and visual impact.

| Type | Use Case | Approach |
|------|----------|----------|
| **Flowchart** | Step-by-step processes, workflows, task sequences | Connect steps with arrows, clearly show process flow |
| **Mind Map** | Concept expansion, topic categorization, brainstorming | Radiate outward from a central core |
| **Hierarchy** | Org charts, content levels, system decomposition | Build level nodes top-down or left-to-right |
| **Relationship** | Dependencies, influences, interactions between elements | Use lines between shapes to show relationships, with arrows and labels |
| **Comparison** | Side-by-side analysis of two or more approaches | Two columns or table format, with comparison dimensions labeled |
| **Timeline** | Event progression, project milestones, evolution | Use time as axis, mark key dates and events |
| **Matrix** | Two-dimensional categorization, priority grids, positioning | Establish X and Y dimensions, place items on coordinate plane |
| **Freeform** | Scattered content, brainstorming, initial information gathering | No structural constraints, freely place blocks and arrows |

## Design Rules

### Text & Format
- **All text elements must use** `fontFamily: 5` (Excalifont handwriting font)
- **Double quote replacement**: replace `"` with `『』`
- **Parentheses replacement**: replace `()` with `「」`
- **Font size rules** (hard minimums — below these values, text is unreadable at normal zoom):
  - Title: 20-28px (minimum 20px)
  - Subtitle: 18-20px
  - Body/labels: 16-18px (minimum 16px)
  - Minor annotations: 14px (only for unimportant auxiliary notes, use sparingly)
  - **Never go below 14px**
- **Line height**: all text uses `lineHeight: 1.25`
- **Text centering**: standalone text elements have no auto-centering — manually calculate x coordinate:
  - Estimate text width: `estimatedWidth = text.length * fontSize * 0.5`
  - Centering formula: `x = centerX - estimatedWidth / 2`
  - Example: text "Hello" (5 chars, fontSize 20) centered at x=300 → `estimatedWidth = 5 * 20 * 0.5 = 50` → `x = 300 - 25 = 275`

### Layout & Design
- **Canvas range**: keep all elements within 0-1200 x 0-800 area
- **Minimum shape size**: rectangles/ellipses with text must be at least 120x60px
- **Element spacing**: minimum 20-30px gap to prevent overlap
- **Clear hierarchy**: use different colors and shapes to distinguish information levels
- **Graphic elements**: use rectangles, circles, arrows etc. to organize information
- **No Emoji**: do not use any Emoji symbols in diagram text — use simple shapes (circles, squares, arrows) or color coding instead

### Color Palette

**Text colors (strokeColor for text):**

| Purpose | Hex | Description |
|---------|-----|-------------|
| Title | `#1e40af` | Deep blue |
| Subtitle/connectors | `#3b82f6` | Bright blue |
| Body text | `#374151` | Dark gray (minimum `#757575` on white background) |
| Emphasis/highlight | `#f59e0b` | Gold |

**Shape fill colors (backgroundColor, fillStyle: "solid"):**

| Hex | Semantic | Use Case |
|-----|----------|----------|
| `#a5d8ff` | Light blue | Input, data source, primary nodes |
| `#b2f2bb` | Light green | Success, output, completed |
| `#ffd8a8` | Light orange | Warning, pending, external dependency |
| `#d0bfff` | Light purple | Processing, middleware, special items |
| `#ffc9c9` | Light red | Error, critical, alert |
| `#fff3bf` | Light yellow | Notes, decisions, planning |
| `#c3fae8` | Light teal | Storage, data, cache |
| `#eebefa` | Light pink | Analysis, metrics, statistics |

**Region background colors (large rectangle + opacity: 30, for layered diagrams):**

| Hex | Semantic |
|-----|----------|
| `#dbe4ff` | Frontend/UI layer |
| `#e5dbff` | Logic/processing layer |
| `#d3f9d8` | Data/tools layer |

**Contrast rules:**
- Text on white background must be no lighter than `#757575`
- On light fills, use dark color variants (e.g., on light green use `#15803d`, not `#22c55e`)
- Avoid light gray text (`#b0b0b0`, `#999`) on white backgrounds

See [references/excalidraw-schema.md](references/excalidraw-schema.md) for full reference.

## JSON Structure

**Obsidian mode:**
```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://github.com/zsviczian/obsidian-excalidraw-plugin",
  "elements": [...],
  "appState": { "gridSize": null, "viewBackgroundColor": "#ffffff" },
  "files": {}
}
```

**Standard / Animated mode:**
```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [...],
  "appState": { "gridSize": null, "viewBackgroundColor": "#ffffff" },
  "files": {}
}
```

## Element Template

Each element requires these fields (do NOT add extra fields like `frameId`, `index`, `versionNonce`, `rawText` -- they may cause issues on excalidraw.com. `boundElements` must be `null` not `[]`, `updated` must be `1` not timestamps):

```json
{
  "id": "unique-id",
  "type": "rectangle",
  "x": 100, "y": 100,
  "width": 200, "height": 50,
  "angle": 0,
  "strokeColor": "#1e1e1e",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "strokeStyle": "solid",
  "roughness": 1,
  "opacity": 100,
  "groupIds": [],
  "roundness": {"type": 3},
  "seed": 123456789,
  "version": 1,
  "isDeleted": false,
  "boundElements": null,
  "updated": 1,
  "link": null,
  "locked": false
}
```

`strokeStyle` values: `"solid"` (default) | `"dashed"` | `"dotted"`. Dashed lines are suitable for optional paths, async flows, weak associations, etc.

Text elements add:
```json
{
  "text": "Display text",
  "fontSize": 20,
  "fontFamily": 5,
  "textAlign": "center",
  "verticalAlign": "middle",
  "containerId": null,
  "originalText": "Display text",
  "autoResize": true,
  "lineHeight": 1.25
}
```

**Animated mode additionally adds** a `customData` field:
```json
{
  "id": "title-1",
  "type": "text",
  "customData": {
    "animate": {
      "order": 1,
      "duration": 500
    }
  },
  ...other fields
}
```

See [references/excalidraw-schema.md](references/excalidraw-schema.md) for all element types.

---

## Additional Technical Requirements

### Text Elements Handling
- The `## Text Elements` section in Markdown **must be left empty**, using only `%%` as delimiters
- The Obsidian Excalidraw plugin will **automatically populate text elements** from the JSON data
- No need to manually list all text content

### Coordinates & Layout
- **Coordinate system**: origin (0,0) is at the top-left
- **Recommended range**: all elements within 0-1200 x 0-800 pixels
- **Element IDs**: each element needs a unique `id` (can be strings like "title", "box1", etc.)

### Required Fields for All Elements

**IMPORTANT**: Do NOT include `frameId`, `index`, `versionNonce`, or `rawText` fields. Use `boundElements: null` (not `[]`), and `updated: 1` (not timestamps).

```json
{
  "id": "unique-identifier",
  "type": "rectangle|text|arrow|ellipse|diamond",
  "x": 100, "y": 100,
  "width": 200, "height": 50,
  "angle": 0,
  "strokeColor": "#color-hex",
  "backgroundColor": "transparent|#color-hex",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "strokeStyle": "solid|dashed|dotted",
  "roughness": 1,
  "opacity": 100,
  "groupIds": [],
  "roundness": {"type": 3},
  "seed": 123456789,
  "version": 1,
  "isDeleted": false,
  "boundElements": null,
  "updated": 1,
  "link": null,
  "locked": false
}
```

### Text-Specific Properties
Text elements (type: "text") require additional properties (do NOT include `rawText`):
```json
{
  "text": "Display text",
  "fontSize": 20,
  "fontFamily": 5,
  "textAlign": "center",
  "verticalAlign": "middle",
  "containerId": null,
  "originalText": "Display text",
  "autoResize": true,
  "lineHeight": 1.25
}
```

### appState Configuration
```json
"appState": {
  "gridSize": null,
  "viewBackgroundColor": "#ffffff"
}
```

### files Field
```json
"files": {}
```

## Common Mistakes to Avoid

- **Text offset** — standalone text element `x` is the left edge, not center. Must use the centering formula to manually calculate, or text will be off to one side
- **Element overlap** — elements with similar y coordinates easily stack. Check for at least 20px spacing before placing new elements
- **Insufficient canvas padding** — don't place content flush with canvas edges. Leave 50-80px padding on all sides
- **Title not centered over diagram** — title should be centered over the overall width of the diagram below it, not fixed at x=0
- **Arrow label overflow** — long text labels (e.g., "ATP + NADPH") will exceed short arrows. Keep labels short or increase arrow length
- **Insufficient contrast** — light text on white background is nearly invisible. Text color must be no lighter than `#757575`; colored text should use dark variants
- **Font size too small** — below 14px is unreadable at normal zoom; body text minimum is 16px

## Implementation Notes

### Auto-save & File Generation Workflow

When generating an Excalidraw diagram, **automatically execute these steps:**

#### 1. Choose the appropriate diagram type
- Based on the content provided by the user, refer to the "Diagram Types & Selection Guide" table above
- Analyze the core requirements of the content and select the most suitable visualization

#### 2. Generate a meaningful filename

Select file extension based on output mode:

| Mode | Filename Format | Example |
|------|----------------|---------|
| Obsidian | `[topic].[type].md` | `business-model.relationship.md` |
| Standard | `[topic].[type].excalidraw` | `business-model.relationship.excalidraw` |
| Animated | `[topic].[type].animate.excalidraw` | `business-model.relationship.animate.excalidraw` |

#### 3. Auto-save using the Write tool
- **Save location**: current working directory (auto-detect from environment)
- **Full path**: `{current_directory}/[filename].md`
- This enables flexible migration without hardcoded paths

#### 4. Ensure Markdown structure is completely correct
**Must generate in the following format** (no modifications allowed):

```markdown
---
excalidraw-plugin: parsed
tags: [excalidraw]
---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'

# Excalidraw Data

## Text Elements
%%
## Drawing
\`\`\`json
{complete JSON data}
\`\`\`
%%
```

#### 5. JSON data requirements
- Include complete Excalidraw JSON structure
- All text elements use `fontFamily: 5`
- Replace `"` with `『』` in text
- Replace `()` with `「」` in text
- JSON format must be valid and pass syntax checking
- All elements have unique `id` values
- Include `appState` and `files: {}` fields

#### 6. User feedback and confirmation
Report to the user:
- Diagram has been generated
- Exact save location
- How to view it in Obsidian
- Design choices made (what diagram type was chosen and why)
- Whether adjustments or modifications are needed

### Example Output Messages

**Obsidian mode:**
```
Excalidraw diagram generated!

Saved to: business-model.relationship.md

Usage:
1. Open this file in Obsidian
2. Click the MORE OPTIONS menu (top right)
3. Select "Switch to EXCALIDRAW VIEW"
```

**Standard mode:**
```
Excalidraw diagram generated!

Saved to: business-model.relationship.excalidraw

Usage:
1. Open https://excalidraw.com
2. Click top-left menu → Open → select this file
3. Or drag and drop the file onto the excalidraw.com page
```

**Animated mode:**
```
Animated Excalidraw diagram generated!

Saved to: business-model.relationship.animate.excalidraw

Animation order: Title(1) → Main framework(2-4) → Connectors(5-7) → Detail text(8-10)

To generate animation:
1. Open https://dai-shi.github.io/excalidraw-animate/
2. Click Load File and select this file
3. Preview the animation
4. Click Export to save as SVG or WebM
```
