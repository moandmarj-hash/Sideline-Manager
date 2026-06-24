# Sideline Manager – exact tiny visual tweaks patch

This patch is designed to be applied to the current **rollback + mobile polish** version.
It only changes these items:

1. Tagline font colour -> black
2. Start button + Next interval button -> black
3. Current block split badge -> amber/yellow like the paused badge
4. GO ON NOW chips get more even vertical spacing between the GO ON NOW and COME OFF NOW headings
5. Title, grass strip, and tagline are tightened slightly so they sit more neatly with the icon

## Apply these changes

### File: `src/App.jsx`

#### 1) Change the current block split badge from red to amber

Find:

```jsx
<Badge tone="red">{row.splitLabel}</Badge>
```

Change to:

```jsx
<Badge tone="amber">{row.splitLabel}</Badge>
```

#### 2) Add a wrapper class to `ChipRow`

Find the `ChipRow` return line that looks like this:

```jsx
return <div><div className="eyebrow">{title}</div><div className="chip-wrap compact">{list.length ? list.map((n)=><PlayerChip key={`${title}-${n}`} name={n} tone={tone} />) : <div className="muted">{emptyText}</div>}</div></div>
```

Change it to:

```jsx
return <div className="chip-row-block"><div className="eyebrow">{title}</div><div className="chip-wrap compact">{list.length ? list.map((n)=><PlayerChip key={`${title}-${n}`} name={n} tone={tone} />) : <div className="muted">{emptyText}</div>}</div></div>
```

---

### File: `src/styles.css`

#### 3) Make the tagline black and slightly tighter

Find:

```css
.hero-tagline{font-size:.92rem;letter-spacing:.15em;font-weight:800;color:#b9262e;padding-left:2px}.landing-tag{color:#fff7f7}
```

Replace with:

```css
.hero-tagline{font-size:.88rem;letter-spacing:.13em;font-weight:800;color:#111111;padding-left:2px}.landing-tag{color:#111111}
```

#### 4) Make Start / Next interval buttons black

Find:

```css
.btn-primary{background:var(--brand-red-dark);color:white}
```

Replace with:

```css
.btn-primary{background:#111111;color:white}
```

#### 5) Tighten the title sizing a touch

Find:

```css
.title-badge.app h1{font-size:2.55rem;line-height:1}.title-badge.landing h1{font-size:2.2rem;line-height:1}
```

Replace with:

```css
.title-badge.app h1{font-size:2.42rem;line-height:1}.title-badge.landing h1{font-size:2.08rem;line-height:1}
```

#### 6) Tighten title/tagline spacing

Find:

```css
.hero-copy,.landing-copy{display:grid;gap:6px;min-width:0}.hero-banner{justify-content:flex-start}
```

Replace with:

```css
.hero-copy,.landing-copy{display:grid;gap:4px;min-width:0}.hero-banner{justify-content:flex-start}
```

#### 7) Slightly reduce grass strip width

Find:

```css
.grass-strip{width:290px;max-width:100%;height:auto;display:block}.grass-strip.large{width:330px}
```

Replace with:

```css
.grass-strip{width:280px;max-width:100%;height:auto;display:block}.grass-strip.large{width:320px}
```

#### 8) Add even spacing for GO ON NOW chip sections

Add these rules near the chip styling area:

```css
.chip-row-block{display:grid;align-content:start;min-height:74px}
.console-panel .chip-row-block + .chip-row-block{margin-top:8px}
.banner-copy{align-content:center}
```

#### 9) Optional mobile tightening (recommended)

In the mobile media query, find:

```css
.title-badge.app h1{font-size:1.42rem}.title-badge.landing h1{font-size:1.55rem}.grass-strip{width:170px}.grass-strip.large{width:210px}.hero-tagline{font-size:.68rem;letter-spacing:.12em}
```

Replace with:

```css
.title-badge.app h1{font-size:1.34rem}.title-badge.landing h1{font-size:1.46rem}.grass-strip{width:160px}.grass-strip.large{width:200px}.hero-tagline{font-size:.62rem;letter-spacing:.11em}
```
