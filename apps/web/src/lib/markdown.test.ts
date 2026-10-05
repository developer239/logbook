import { describe, expect, it } from 'vitest'
import { markdown } from './markdown'

describe('markdown', () => {
  it('should escape markup the source wrote as text', () => {
    expect(markdown('<script>alert("x")</script> & <b>')).toBe(
      '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;b&gt;</p>'
    )
  })

  it('should split paragraphs on blank lines and keep single line breaks', () => {
    expect(markdown('one\ntwo\n\nthree')).toBe('<p>one<br>two</p><p>three</p>')
  })

  it('should keep fenced code as written, escaped', () => {
    expect(markdown('Run:\n```sh\npnpm test <x>\n\n**not bold**\n```\nDone')).toBe(
      '<p>Run:</p><pre><code>pnpm test &lt;x&gt;\n\n**not bold**</code></pre><p>Done</p>'
    )
  })

  it('should render lists, headings, inline code and bold', () => {
    expect(markdown('## Findings\n- the `tenant_id` index\n- **seed** file\n1. first\n2. second')).toBe(
      '<p><b>Findings</b></p><ul><li>the <code>tenant_id</code> index</li><li><b>seed</b> file</li></ul>' +
        '<ol><li>first</li><li>second</li></ol>'
    )
  })

  it('should not read markup inside inline code', () => {
    expect(markdown('`**a** <i>`')).toBe('<p><code>**a** &lt;i&gt;</code></p>')
  })

  it('should bold inline code wrapped in bold', () => {
    expect(markdown('- **`src/modules/`** (388 files)')).toBe(
      '<ul><li><b><code>src/modules/</code></b> (388 files)</li></ul>'
    )
  })
})
