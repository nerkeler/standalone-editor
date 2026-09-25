---
title: "Source-only constructs"
tags: [docs, fidelity]
---

# Source-only constructs

Wiki links [[Target Note]] and ![[diagram.png]] need their original syntax.

Escaped punctuation: \*literal emphasis\*.

Reference style: [documentation][docs].

Footnote use[^note].

[^note]: The editor does not implement Markdown footnotes.

## Aligned table

| Left | Center | Right |
| :--- | :---: | ---: |
| A | B | C |

## Nested list

- Parent
  - Nested child

## Raw HTML and comment

<details>
<summary>Disclosure</summary>
Body content.
</details>

<!-- retain this source comment -->

## Fenced code metadata

```ts title="sample.ts"
const sourceMetadata = true;
```

[docs]: https://example.com/docs "Documentation"
