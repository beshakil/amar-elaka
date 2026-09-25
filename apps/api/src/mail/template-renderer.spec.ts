import { renderMailTemplate } from './template-renderer';

describe('renderMailTemplate', () => {
  it('compiles the mjml template and interpolates params', async () => {
    const html = await renderMailTemplate('notice', { heading: 'শিরোনাম', body: 'বার্তা' });

    expect(html).toContain('শিরোনাম');
    expect(html).toContain('বার্তা');
    expect(html).not.toMatch(/\{\{\s*(heading|body)\s*\}\}/);
  });

  it('leaves a placeholder with no matching param untouched', async () => {
    const html = await renderMailTemplate('notice', { heading: 'শিরোনাম' });

    expect(html).toMatch(/\{\{\s*body\s*\}\}/);
  });

  it('escapes HTML in interpolated values', async () => {
    const html = await renderMailTemplate('notice', {
      heading: '<script>alert(1)</script>',
      body: 'ok',
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('rejects an unknown template', async () => {
    await expect(renderMailTemplate('does-not-exist', {})).rejects.toThrow();
  });
});
