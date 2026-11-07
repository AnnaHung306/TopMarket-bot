// Render the report card's own markup and stylesheet into the export.
export async function renderWalletPoster(card, background, complete, tools) {
  const css = document.querySelector('head style').textContent;
  const cardStyle = getComputedStyle(card);
  const width = Math.round(card.getBoundingClientRect().width);
  const radius = parseFloat(cardStyle.borderTopLeftRadius);
  const margin = 16;
  const viewWidth = width + 2 * margin;
  const source = card.cloneNode(true);
  source.querySelectorAll(
    '#posterDate, .poster-actions, #posterStatus, #posterFile, #posterImage'
  ).forEach(node => node.remove());
  if (!complete) source.querySelector('.poster-total .caption').textContent = '已識別淨收支（部分）';
  source.removeAttribute('id');
  source.removeAttribute('aria-labelledby');
  source.removeAttribute('data-glass-refraction');
  source.style.removeProperty('--glass-refraction-filter');
  source.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));

  // Keep the live card's width and responsive padding in the standalone image.
  Object.assign(source.style, {
    position: 'relative',
    top: 'auto',
    width: width + 'px',
    padding: cardStyle.padding,
    backdropFilter: 'none',
  });
  const index = source.querySelector('.section-index');
  index.style.fontSize = getComputedStyle(card.querySelector('.section-index')).fontSize;
  source.style.visibility = 'hidden';
  document.body.append(source);
  const height = Math.ceil(source.getBoundingClientRect().height);
  source.remove();
  source.style.removeProperty('visibility');
  const viewHeight = height + 2 * margin;
  const pngWidth = 2160;
  const pngHeight = Math.round(pngWidth * viewHeight / viewWidth);
  const scale = pngWidth / viewWidth;

  const baseColor = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
  const canvas = document.createElement('canvas');
  canvas.width = pngWidth;
  canvas.height = pngHeight;
  const context = canvas.getContext('2d');
  context.fillStyle = baseColor;
  context.fillRect(0, 0, pngWidth, pngHeight);
  const frame = background.captureReportBackground?.();
  if (frame) {
    const bgRect = background.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    // The desktop poster starts beside the query card, even after it sticks on scroll.
    const top = cardStyle.position === 'sticky'
      ? document.querySelector('.query').getBoundingClientRect().top
      : cardRect.top;
    context.imageSmoothingQuality = 'high';
    context.drawImage(frame, (bgRect.left - cardRect.left + margin) * scale,
      (bgRect.top - top + margin) * scale, bgRect.width * scale, bgRect.height * scale);
  }

  const svgNamespace = 'http://www.w3.org/2000/svg';
  const htmlNamespace = 'http://www.w3.org/1999/xhtml';
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('width', pngWidth);
  svg.setAttribute('height', pngHeight);
  svg.setAttribute('viewBox', '0 0 ' + pngWidth + ' ' + pngHeight);

  function shape(name, attributes, parent = svg) {
    const element = document.createElementNS(svgNamespace, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    parent.append(element);
    return element;
  }

  if (frame && card.dataset.glassRefraction === 'active') {
    const { edgeWidth, strength, dispersion } = tools.profiles.poster;
    const rim = tools.makeMap(document, width, height, Array(4).fill(radius), edgeWidth);
    const defs = shape('defs', {});
    const clip = shape('clipPath', { id: 'poster-clip' }, defs);
    shape('rect', { x: 0, y: 0, width, height, rx: radius }, clip);
    const filter = tools.makeFilter(document, 'poster-refraction', width, height, rim, strength, dispersion);
    defs.append(filter.querySelector('filter'));
    const crop = document.createElement('canvas');
    crop.width = width;
    crop.height = height;
    crop.getContext('2d').drawImage(canvas, margin * scale, margin * scale,
      width * scale, height * scale, 0, 0, width, height);
    const inside = shape('g', { transform: 'scale(' + scale + ') translate(' + margin + ' ' + margin + ')' });
    shape('image', {
      href: crop.toDataURL('image/png'),
      width,
      height,
      'clip-path': 'url(#poster-clip)',
      filter: 'blur(0.5px) saturate(117%) url(#poster-refraction)',
    }, inside);
  }

  // WebKit paints the HTML at CSS pixel size even when an SVG viewBox scales it.
  const content = shape('foreignObject', {
    x: margin * scale, y: margin * scale, width: width * scale, height: height * scale,
  });
  const wrapper = document.createElementNS(htmlNamespace, 'div');
  wrapper.style.zoom = scale;
  const style = document.createElementNS(htmlNamespace, 'style');
  style.textContent = css + '\n:root { background: transparent; }';
  wrapper.append(style, source);
  content.append(wrapper);

  const image = new Image();
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
  await image.decode();
  context.drawImage(image, 0, 0);
  return canvas;
}
