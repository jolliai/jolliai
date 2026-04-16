# Swing Layout: GridBagLayout Text Vanishing in Narrow Windows

## Problem

When using `GridBagLayout` inside a Swing `JTree` cell renderer to lay out a row of components (checkbox + text JLabel + icon), **the text completely disappears** as the window narrows, instead of being truncated with an ellipsis (`...`) as expected.

## Root Cause

`GridBagLayout`'s shrink algorithm proportionally reduces all columns with `weightx > 0` when space is insufficient. When available space becomes very small, the text label's width is compressed to 0, causing the entire text to vanish. Key details:

- Even with `minimumSize = Dimension(0, 0)`, `GridBagLayout`'s space allocation remains unreliable — long messages vanish before short ones begin truncating.
- Manual text-clipping logic (e.g., `truncateFromLeft()`) adds complexity and depends on `FontMetrics` calculations that are error-prone.
- `GridBagLayout` still **reserves space** for components with `isVisible = false` by default, so hiding unused columns does not free up space.

## Solution

Replace `GridBagLayout` with `BorderLayout`:

```kotlin
// Before
JPanel(GridBagLayout())

// After
JPanel(BorderLayout(2, 0))
```

Then place components into the three regions:

```kotlin
commitPanel.add(checkBox, BorderLayout.WEST)

messageLabel.minimumSize = Dimension(0, 0)
commitPanel.add(messageLabel, BorderLayout.CENTER)

commitPanel.add(eyeLabel, BorderLayout.EAST)
```

## Why BorderLayout Works

`BorderLayout`'s space allocation logic is: **give WEST and EAST their preferred sizes first, then assign all remaining space to CENTER**. This means:

1. The text label always receives **all remaining space** after the checkbox and icon are placed.
2. When space is tight, `JLabel`'s built-in ellipsis truncation (`...`) kicks in automatically.
3. No manual `FontMetrics` calculations or custom clipping logic are needed.

## Additional Notes

For the cell renderer to work correctly with `BorderLayout`, two extra steps are still required:

```kotlin
// Constrain the panel to the tree's visible width
val availableWidth = calculateAvailableWidth(tree, nodeDepth)
if (availableWidth > 0) {
    val h = commitPanel.preferredSize.height
    commitPanel.preferredSize = Dimension(availableWidth, h)
    commitPanel.setSize(availableWidth, h)
}

// Force layout before the tree paints (rubber-stamp rendering)
commitPanel.doLayout()
```

Without `setSize()` + `doLayout()`, `BorderLayout` may not distribute space to `messageLabel` on the first render, because `JTree` uses the renderer as a rubber stamp — it captures a snapshot without triggering a real layout pass.

## General Guidance

| Scenario | Recommended Layout |
|:--|:--|
| Fixed components on both ends + one component filling the rest | `BorderLayout` |
| Multiple columns with proportional or complex alignment | `GridBagLayout` |
| Simple cell renderers (tree / list / table) | `BorderLayout` or `BoxLayout` |

**Takeaway**: When the requirement is "pin two ends, fill the middle," `BorderLayout` is the simplest and most reliable choice. `GridBagLayout`'s shrink behavior is unpredictable in constrained-width scenarios like cell renderers, and can compress components to invisibility.
