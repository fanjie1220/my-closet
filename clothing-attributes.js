(function (root, factory) {
  const taxonomy = typeof module === 'object' && module.exports ? require('./garment-taxonomy.js') : root.GarmentTaxonomy;
  const api = factory(taxonomy);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClothingAttributes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (taxonomy) {
  const swatches = taxonomy.fields.colors.swatches;
  const family = taxonomy.fields.colors.families;

  // UI swatches are illustrative colors, not boundaries between fabric colors.
  // Work in OKLab so muted beige cannot be pulled towards a pink RGB swatch.
  const linear = Array.from({ length: 256 }, (_, channel) => {
    const value = channel / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  function perceptualColor(r, g, b) {
    const red = linear[r], green = linear[g], blue = linear[b];
    const l = Math.cbrt(.4122214708 * red + .5363325363 * green + .0514459929 * blue);
    const m = Math.cbrt(.2119034982 * red + .6806995451 * green + .1073969566 * blue);
    const s = Math.cbrt(.0883024619 * red + .2817188376 * green + .6299787005 * blue);
    const lightness = .2104542553 * l + .7936177850 * m - .0040720468 * s;
    const a = 1.9779984951 * l - 2.4285922050 * m + .4505937099 * s;
    const yellow = .0259040371 * l + .7827717662 * m - .8086757660 * s;
    return { lightness, chroma: Math.hypot(a, yellow), hue: (Math.atan2(yellow, a) * 180 / Math.PI + 360) % 360 };
  }
  function pixelColor({ lightness: l, chroma: c, hue: h }) {
    const warm = h >= 45 && h <= 110;
    // Warm undertones remain visible in beige/khaki even at low saturation.
    if (l < .24 || c < (warm ? .018 : .028)) return l < .45 ? '黑色' : l >= .87 ? '白色' : '灰色';
    if (h < 35 || h >= 335) return l >= .70 && c < .19 ? '粉色' : '红色';
    if (h < 110) {
      if (l >= .78 && c < .085) return '米色';
      if (l < .53) return '棕色';
      if (c < .10) return h >= 65 && l >= .55 ? '卡其色' : '棕色';
      return h < 75 ? '橙色' : '黄色';
    }
    if (h < 190) return '绿色';
    if (h < 280) return l < .48 ? '藏青色' : '蓝色';
    return '紫色';
  }

  function foregroundMask(pixels, width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width * height * 4 !== pixels.length || width < 4 || height < 4) return null;
    const size = width * height;
    let transparent = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 180) transparent++;
    if (transparent / size >= .01) return null;
    const border = [];
    for (let x = 0; x < width; x++) border.push(x, (height - 1) * width + x);
    for (let y = 1; y < height - 1; y++) border.push(y * width, y * width + width - 1);
    const background = [0, 1, 2].map(channel => border.map(index => pixels[index * 4 + channel]).sort((a, b) => a - b)[Math.floor(border.length / 2)]);
    const nearBackground = index => Math.max(...background.map((channel, i) => Math.abs(pixels[index * 4 + i] - channel))) <= 22;
    if (border.filter(nearBackground).length / border.length < .85) return null;
    const removed = new Uint8Array(size), queue = [];
    const visit = index => { if (!removed[index] && nearBackground(index)) { removed[index] = 1; queue.push(index); } };
    border.forEach(visit);
    for (let head = 0; head < queue.length; head++) {
      const index = queue[head], x = index % width;
      if (x) visit(index - 1);
      if (x < width - 1) visit(index + 1);
      if (index >= width) visit(index - width);
      if (index < size - width) visit(index + width);
    }
    const remaining = size - queue.length;
    // A uniform image is valid color evidence. Do not erase it, or a white
    // garment that differs from its background only by a small cast shadow.
    if (remaining < size * .10 || queue.length < size * .15) return null;
    const sums = [0, 0, 0];
    for (let index = 0; index < size; index++) if (!removed[index]) for (let c = 0; c < 3; c++) sums[c] += pixels[index * 4 + c];
    const foreground = perceptualColor(...sums.map(value => Math.round(value / remaining)));
    const backdrop = perceptualColor(...background);
    if (Math.abs(foreground.lightness - backdrop.lightness) < .18 && Math.abs(foreground.chroma - backdrop.chroma) < .025) return null;
    return removed;
  }

  function analyzeColor(pixels, { width, height } = {}) {
    const background = foregroundMask(pixels, width, height);
    const counts = {}, families = {}, rgbSums = {}, chromaSums = {};
    let total = 0, neutral = 0, dark = 0, light = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      // Soft mask edges contain background blends; do not count them as fabric.
      if (pixels[i + 3] < 180 || background?.[i / 4]) continue;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const weight = pixels[i + 3] / 255;
      total += weight;
      if (max < 55) dark += weight;
      if (min > 215) light += weight;
      const appearance = perceptualColor(r, g, b);
      const color = pixelColor(appearance);
      if (!family[color]) neutral += weight;
      counts[color] = (counts[color] || 0) + weight;
      if (!rgbSums[color]) rgbSums[color] = { rgb: [0, 0, 0], count: 0 };
      rgbSums[color].rgb[0] += r * weight;
      rgbSums[color].rgb[1] += g * weight;
      rgbSums[color].rgb[2] += b * weight;
      rgbSums[color].count += weight;
      if (family[color]) {
        families[family[color]] = (families[family[color]] || 0) + weight;
        chromaSums[family[color]] = (chromaSums[family[color]] || 0) + appearance.chroma * weight;
      }
    }
    if (!total) return { value: '灰色', score: .2, total: 0, neutralRatio: 0, multicolor: false, families: {} };
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const neutralArea = ['黑色', '白色', '灰色'].reduce((sum, color) => sum + (counts[color] || 0), 0);
    const strongFamilies = Object.entries(families).filter(([, count]) => count / total >= .25);
    // Gray shadows/highlights form one neutral family. Strong black/white
    // contrast is the exception, so black-and-white color blocking still counts.
    const neutralContrast = neutralArea / total >= .25 && strongFamilies.some(([name, count]) => chromaSums[name] / count >= .07);
    const multicolor = strongFamilies.length >= 2 || neutralContrast || (dark / total > .27 && light / total > .27);
    let value = ranked[0][0];
    if (multicolor) value = '多色';
    const dominant = ranked[0] && rgbSums[ranked[0][0]];
    return {
      value, score: multicolor ? .6 : Math.min(.8, .4 + (counts[value] || neutral) / total * .4),
      total, neutralRatio: neutral / total, multicolor, families,
      darkRatio: dark / total, lightRatio: light / total,
      backgroundRemoved: !!background,
      distribution: Object.fromEntries(ranked.map(([name, count]) => [name, count / total])),
      dominantRgb: dominant && dominant.count
        ? dominant.rgb.map(channel => Math.round(channel / dominant.count))
        : null
    };
  }

  function resolveColor(evidence, prediction) {
    const result = { value: evidence.value, score: evidence.score };
    if (!evidence.total || !prediction) return result;
    const strong = prediction.score >= .55 && prediction.margin >= .12;
    // RGB alone cannot distinguish metallic silver from gray fabric.
    if (prediction.value === '银色' && evidence.neutralRatio >= .7 && evidence.darkRatio < .7 && evidence.lightRatio < .65 && !evidence.multicolor && strong) {
      return { value: '银色', score: Math.min(.8, prediction.score) };
    }
    if (prediction.value === '金色' && !evidence.multicolor && ((evidence.families.earth || 0) + (evidence.families.yellow || 0)) / evidence.total >= .5 && strong) {
      return { value: '金色', score: Math.min(.75, prediction.score) };
    }
    // Let the existing model resolve an adjacent shade only when a substantial
    // part of the garment already supports it, e.g. blue denim with navy folds.
    const share = evidence.distribution || {};
    if (!evidence.multicolor && strong && prediction.value !== evidence.value
      && family[prediction.value] && family[prediction.value] === family[evidence.value]
      && share[prediction.value] >= .20 && share[evidence.value] < .80) {
      return { value: prediction.value, score: Math.min(.75, prediction.score) };
    }
    return result;
  }

  function rankPredictions(predictions, prompts, key) {
    const scores = new Map((Array.isArray(predictions) ? predictions : []).map(item => [item.label, Math.max(0, Number(item.score) || 0)]));
    const byValue = new Map();
    for (const prompt of prompts) {
      const rawScore = scores.get(prompt.label) || 0;
      if (!byValue.has(prompt[key]) || rawScore > byValue.get(prompt[key]).rawScore) byValue.set(prompt[key], { value: prompt[key], label: prompt.label, rawScore });
    }
    const ranked = [...byValue.values()].sort((a, b) => b.rawScore - a.rawScore);
    const total = ranked.reduce((sum, item) => sum + item.rawScore, 0);
    if (!total) return null;
    return { ...ranked[0], score: ranked[0].rawScore / total, margin: (ranked[0].rawScore - (ranked[1]?.rawScore || 0)) / total };
  }

  function resolveContext({ category, subcategory, seasonTop, occasionTop }) {
    const usable = value => value && value.score >= .65 && value.margin >= .15;
    let season = usable(seasonTop) ? seasonTop.value : '四季';
    let seasonScore = usable(seasonTop) ? Math.min(.75, seasonTop.score) : .25;
    if (category === '包包') { season = '四季'; seasonScore = .5; }
    // These are defaults based on item type, not high confidence predictions.
    if (subcategory === '羽绒服' && !usable(seasonTop)) { season = '冬'; seasonScore = .5; }
    if (subcategory === '凉鞋' && !usable(seasonTop)) { season = '夏'; seasonScore = .5; }
    const occasion = usable(occasionTop) ? occasionTop.value : '日常';
    const occasionScore = usable(occasionTop) ? Math.min(.75, occasionTop.score) : .25;
    return { season, occasion, seasonScore, occasionScore };
  }

  function rankColor(predictions, prompts, evidence) {
    // Condition semantic matching on visible color evidence. A neutral item
    // should compare black/white/gray/silver, rather than unrelated hues.
    const dominantFamily = Object.entries(evidence.families || {}).sort((a, b) => b[1] - a[1])[0];
    let candidates = prompts;
    if (evidence.neutralRatio >= .85 && !evidence.multicolor) {
      candidates = prompts.filter(prompt => ['黑色', '白色', '灰色', '银色'].includes(prompt.color));
    } else if (!evidence.multicolor && dominantFamily && dominantFamily[1] / evidence.total >= .65) {
      candidates = prompts.filter(prompt => family[prompt.color] === dominantFamily[0]
        || (['earth', 'yellow'].includes(dominantFamily[0]) && prompt.color === '金色'));
    }
    return rankPredictions(predictions, candidates, 'color');
  }

  const namingThresholds = { subcategory: .65, pattern: .7 };
  function clearNamingPrediction(prediction, field) {
    return prediction && prediction.score >= namingThresholds[field] && prediction.margin >= .15;
  }

  function namingRefinementPrompts(category, current = {}) {
    const groups = {};
    if (!taxonomy.fields.subcategory.by_category[category]) return groups;
    const subcategories = taxonomy.prompts('subcategory', 'subcategory', category);
    if (!clearNamingPrediction(current.subcategory, 'subcategory')) {
      groups.subcategory = subcategories.map(prompt => ({ ...prompt, label: `a product photo of ${prompt.label}` }));
    }
    if (!clearNamingPrediction(current.pattern, 'pattern')) {
      const subjects = { 上装: 'a top', 下装: 'a pair of pants', 裙子: 'a skirt or dress', 外套: 'a jacket or coat', 连体装: 'a one-piece outfit', 鞋帽: 'footwear or a hat', 包包: 'a bag', 配饰: 'a fashion accessory' };
      const subject = clearNamingPrediction(current.subcategory, 'subcategory')
        ? subcategories.find(prompt => prompt.subcategory === current.subcategory.value)?.label || subjects[category]
        : subjects[category];
      groups.pattern = taxonomy.prompts('pattern', 'pattern').map(prompt => ({ ...prompt, label: `a product photo of ${subject} with ${prompt.label}` }));
    }
    return groups;
  }

  function refineNamingPredictions(predictions, groups, current) {
    const refined = { ...current };
    for (const [field, prompts] of Object.entries(groups)) {
      const candidate = rankPredictions(predictions, prompts, field);
      // Keep the actual relative score; a close tie must not become a precise name.
      if (clearNamingPrediction(candidate, field)) refined[field] = candidate;
    }
    return refined;
  }

  function generateItemName(item = {}) {
    const MAX_NAME_LENGTH = 12;
    const contract = item.contract || item.recognitionContract || item.recognition || {};
    const attributes = item.attributes || contract.attributes || item;
    const scores = contract.field_confidence || item.fieldScores || {};
    const manual = new Set([...(item.manualFields || []), ...(contract.manualFields || [])]);
    if (manual.has('name') && typeof item.name === 'string' && item.name.trim()) return item.name;
    const review = new Set(contract.review?.fields || []);
    const reviewActions = contract.review?.actions || {};
    const aliases = { colors: 'color', materials: 'material' };
    // These scores are selection signals, not calibrated accuracy probabilities.
    const usable = (field, threshold = .7) => manual.has(field) || manual.has(aliases[field])
      || ((!review.has(field) || reviewActions[field] === 'confirm')
        && reviewActions[field] !== 'manual_required'
        && Number(scores[field] ?? scores[aliases[field]]) >= threshold);
    const category = attributes.category || item.category || '';
    const categoryNames = { 上装: '上衣', 下装: '裤装', 裙子: '裙装', 外套: '外套', 连体装: '连体装', 鞋帽: '鞋帽', 包包: '包包', 配饰: '配饰' };
    const subcategory = String(attributes.subcategory || '').trim();
    const specific = subcategory && !/^(其他|未知|不适用)/.test(subcategory)
      && !Object.hasOwn(categoryNames, subcategory) && subcategory.length <= MAX_NAME_LENGTH
      && usable('subcategory', .65);
    const base = specific ? subcategory : categoryNames[category] || '衣物';
    const color = (attributes.colors || [attributes.color || item.color || ''])[0];
    const colorText = usable('colors') && Object.hasOwn(swatches, color) && color !== '多色' ? color : '';
    const details = [];
    const addDetail = (value, field, threshold) => {
      if (!value || !usable(field, threshold)) return;
      if (base.includes(value) || details.includes(value)) return;
      details.push(value);
    };
    // A clear pattern remains useful even if the exact garment type is uncertain.
    const pattern = attributes.pattern;
    if (['条纹', '格纹', '波点', '印花', '字母', '动物纹', '拼色', '渐变'].includes(pattern)) {
      addDetail(pattern, 'pattern', .7);
    }
    if (specific) {
      // Use visible knit texture, rather than claiming fiber composition from a photo.
      if ((attributes.materials || []).includes('针织')
        && ['上装', '外套', '裙子', '连体装'].includes(category)) {
        addDetail('针织', 'materials', .75);
      }
      if (['上装', '外套', '裙子', '连体装'].includes(category)) {
        const length = { 超短: '超短款', 短: '短款', 中长: '中长款', 长: '长款' }[attributes.length] || '';
        addDetail(length, 'length', .7);
      }
      if (['上装', '下装', '外套', '裙子', '连体装'].includes(category)) {
        const fit = { 修身: '修身', 宽松: '宽松', 廓形: '廓形' }[attributes.fit] || '';
        addDetail(fit, 'fit', .75);
      }
    }
    // Preserve the existing priority: pattern, knit texture, length, then fit.
    const selected = details.slice(0, 2);
    while (selected.length && (colorText + selected.join('') + base).length > MAX_NAME_LENGTH) {
      selected.pop();
    }
    const detailedName = colorText + selected.join('') + base;
    if (detailedName.length <= MAX_NAME_LENGTH) return detailedName;
    return base;
  }

  return { analyzeColor, resolveColor, resolveContext, rankPredictions, rankColor, namingRefinementPrompts, refineNamingPredictions, generateItemName };
});
