/**
 * Chinese labels for Modrinth metadata.
 *
 * The Modrinth API only exposes machine-readable tag ids (`optimization`,
 * `fabric`, `release` …) — it has no localised project titles or descriptions.
 * We translate everything the API does give us so the browser reads naturally
 * in Chinese, and fall back to the raw id for anything we don't know.
 */

/** Category / feature tags (the `categories` field of a search hit). */
const CATEGORY_ZH: Record<string, string> = {
  // ---- mod categories ----
  adventure: '冒险',
  cursed: '搞怪',
  decoration: '装饰',
  economy: '经济',
  equipment: '装备',
  food: '食物',
  'game-mechanics': '游戏机制',
  library: '前置库',
  magic: '魔法',
  management: '管理',
  minigame: '小游戏',
  mobs: '生物',
  optimization: '优化',
  social: '社交',
  storage: '存储',
  technology: '科技',
  transportation: '交通',
  utility: '实用',
  worldgen: '世界生成',

  // ---- modpack categories ----
  challenging: '高难度',
  combat: '战斗',
  'kitchen-sink': '大杂烩',
  lightweight: '轻量',
  multiplayer: '多人',
  quests: '任务',
  // adventure / magic / optimization / technology shared with mods

  // ---- shader categories ----
  atmosphere: '氛围',
  bloom: '泛光',
  cartoon: '卡通',
  'colored-lighting': '彩色光照',
  fantasy: '奇幻',
  foliage: '植被',
  high: '高配',
  low: '低配',
  medium: '中配',
  'path-tracing': '光线追踪',
  pbr: 'PBR 材质',
  potato: '极限低配',
  realistic: '写实',
  reflections: '反射',
  screenshot: '截图向',
  'semi-realistic': '半写实',
  shadows: '阴影',
  'vanilla-like': '原版风格',

  // ---- resource pack categories ----
  '128x': '128x 分辨率',
  '16x': '16x 分辨率',
  '256x': '256x 分辨率',
  '32x': '32x 分辨率',
  '48x': '48x 分辨率',
  '512x+': '512x+ 分辨率',
  '64x': '64x 分辨率',
  '8x-': '8x 以下',
  audio: '音效',
  blocks: '方块',
  'core-shaders': '核心光影',
  entities: '实体',
  environment: '环境',
  fonts: '字体',
  gui: '界面',
  items: '物品',
  locale: '语言',
  modded: '模组兼容',
  models: '模型',
  simplistic: '简约',
  themed: '主题',
  tweaks: '微调',
};

/** Mod loaders (also returned inside `categories`). */
const LOADER_ZH: Record<string, string> = {
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
  liteloader: 'LiteLoader',
  rift: 'Rift',
  modloader: 'ModLoader',
  'legacy-fabric': 'Legacy Fabric',
  ornithe: 'Ornithe',
  babric: 'Babric',
  'bta-babric': 'BTA Fabric',
  canvas: 'Canvas',
  iris: 'Iris',
  optifine: 'OptiFine',
  minecraft: '原版',
  datapack: '数据包',
  vanilla: '原版',
  paper: 'Paper',
  purpur: 'Purpur',
  spigot: 'Spigot',
  bukkit: 'Bukkit',
  folia: 'Folia',
};

const VERSION_TYPE_ZH: Record<string, string> = {
  release: '正式版',
  beta: '测试版',
  alpha: '预览版',
};

/** Translate a category / loader tag, falling back to the raw id. */
export function tagLabel(tag: string): string {
  const key = tag.toLowerCase();
  return CATEGORY_ZH[key] ?? LOADER_ZH[key] ?? tag;
}

/** Translate a Modrinth release channel. */
export function versionTypeLabel(type: string): string {
  return VERSION_TYPE_ZH[type.toLowerCase()] ?? type;
}

/** Translate the loader filter dropdown. */
export function loaderLabel(loader: string): string {
  return LOADER_ZH[loader.toLowerCase()] ?? loader;
}
