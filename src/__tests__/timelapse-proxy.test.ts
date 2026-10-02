import { describe, expect, it } from 'vitest';
import { resolveTimelapseUpstream } from '../server/timelapse-proxy';

const PRINTER = '192.0.2.10';

describe('resolveTimelapseUpstream', () => {
  it("accepts the printer's absolute URL and keeps its port and query", () => {
    expect(resolveTimelapseUpstream(`http://${PRINTER}:8080/video/a.mp4?x=1`, PRINTER)).toEqual({
      ok: true,
      port: 8080,
      path: '/video/a.mp4?x=1',
    });
  });

  it('defaults to the printer HTTP port (80) when the URL has none', () => {
    expect(resolveTimelapseUpstream(`http://${PRINTER}/video/a.mp4`, PRINTER)).toEqual({
      ok: true,
      port: 80,
      path: '/video/a.mp4',
    });
  });

  it('accepts a plain path and a bare name', () => {
    expect(resolveTimelapseUpstream('/opt/usr/video/a.mp4', PRINTER)).toEqual({
      ok: true,
      port: 80,
      path: '/opt/usr/video/a.mp4',
    });
    expect(resolveTimelapseUpstream('a.mp4', PRINTER)).toEqual({
      ok: true,
      port: 80,
      path: '/a.mp4',
    });
  });

  it('rejects a foreign host', () => {
    const r = resolveTimelapseUpstream('http://198.51.100.7/video/a.mp4', PRINTER);
    expect(r.ok).toBe(false);
  });

  it('rejects host tricks: userinfo, protocol-relative, lookalike', () => {
    expect(resolveTimelapseUpstream(`http://${PRINTER}@198.51.100.7/a.mp4`, PRINTER).ok).toBe(
      false,
    );
    expect(resolveTimelapseUpstream('//198.51.100.7/a.mp4', PRINTER).ok).toBe(false);
    expect(resolveTimelapseUpstream(`http://${PRINTER}.evil.invalid/a.mp4`, PRINTER).ok).toBe(
      false,
    );
  });

  it('rejects traversal, raw and encoded', () => {
    expect(resolveTimelapseUpstream('/video/../etc/passwd', PRINTER).ok).toBe(false);
    expect(resolveTimelapseUpstream('/video/%2e%2e/etc/passwd', PRINTER).ok).toBe(false);
    expect(resolveTimelapseUpstream(`http://${PRINTER}/a/../b.mp4`, PRINTER).ok).toBe(false);
  });

  it('rejects backslashes and control characters', () => {
    expect(resolveTimelapseUpstream('video\\a.mp4', PRINTER).ok).toBe(false);
    expect(resolveTimelapseUpstream('/video/%5ca.mp4', PRINTER).ok).toBe(false);
    expect(resolveTimelapseUpstream('/video/a\r\nHost: x.mp4', PRINTER).ok).toBe(false);
    expect(resolveTimelapseUpstream('/video/a%00.mp4', PRINTER).ok).toBe(false);
  });

  it('rejects non-http schemes', () => {
    expect(resolveTimelapseUpstream(`https://${PRINTER}/a.mp4`, PRINTER).ok).toBe(false);
    expect(resolveTimelapseUpstream('file:///etc/passwd', PRINTER).ok).toBe(false);
    expect(resolveTimelapseUpstream('javascript:alert(1)', PRINTER).ok).toBe(false);
  });

  it('rejects empty, missing and path-less values', () => {
    expect(resolveTimelapseUpstream('', PRINTER).ok).toBe(false);
    expect(resolveTimelapseUpstream('   ', PRINTER).ok).toBe(false);
    expect(resolveTimelapseUpstream(null, PRINTER).ok).toBe(false);
    expect(resolveTimelapseUpstream(`http://${PRINTER}/`, PRINTER).ok).toBe(false);
  });
});
