const texts = {
  en: {
    open: 'Open',
    nav: 'Nav',
    sel: 'Sel',
    eraser: 'Eraser',
    size: 'Size',
    pts: 'Pts',
    all: 'All',
    delete: 'Delete',
    keep: 'Keep',
    undo: 'Undo',
    save: 'Save',
    clear: 'Esc',
    edits: 'edit(s)',
    unsaved: 'Unsaved',
    total: 'Total',
    display: 'Display',
    loading: 'Loading',
    saving: 'Saving',
    loaded: 'Loaded',
    saved: 'Saved',
    noEdits: 'No edits',
    nothingToUndo: 'Nothing to undo',
    undone: 'Undone',
    deleted: 'Deleted',
    keptRemoved: 'Kept, removed',
    erased: 'Erased',
    saveFailed: 'Save failed',
    pts_suffix: 'pts',
    dragDrop: 'Drag & drop a .las file, or click Open',
    intensity: 'Intensity',
    rgb: 'RGB',
    height: 'Height',
    heightInt: 'Height+Int',
    shading: 'Shading',
    warmLight: 'Warm Light',
    white: 'White',
    persp: 'persp',
    top: 'top',
    bottom: 'bottom',
    front: 'front',
    back: 'back',
    right: 'right',
    left: 'left',
    lang: 'EN',
  },
  zh: {
    open: '打开',
    nav: '导航',
    sel: '选择',
    eraser: '橡皮擦',
    size: '大小',
    pts: '点数',
    all: '全部',
    delete: '删除',
    keep: '保留',
    undo: '撤销',
    save: '保存',
    clear: '取消',
    edits: '次编辑',
    unsaved: '未保存',
    total: '总计',
    display: '显示',
    loading: '加载中',
    saving: '保存中',
    loaded: '已加载',
    saved: '已保存',
    noEdits: '无编辑',
    nothingToUndo: '无可撤销',
    undone: '已撤销',
    deleted: '已删除',
    keptRemoved: '保留，移除',
    erased: '已擦除',
    saveFailed: '保存失败',
    pts_suffix: '点',
    dragDrop: '拖放 .las 文件，或点击打开',
    intensity: '强度',
    rgb: 'RGB',
    height: '高度',
    heightInt: '高度+强度',
    shading: '着色',
    warmLight: '暖光',
    white: '白色',
    persp: '透视',
    top: '顶',
    bottom: '底',
    front: '前',
    back: '后',
    right: '右',
    left: '左',
    lang: '中',
  },
} as const

export type Lang = keyof typeof texts
export type TextKey = keyof typeof texts.en

const STORAGE_KEY = 'open3d-lang'

function detectLang(): Lang {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'zh' || stored === 'en') return stored
  const nav = navigator.language.toLowerCase()
  return nav.startsWith('zh') ? 'zh' : 'en'
}

let currentLang: Lang = detectLang()
const listeners = new Set<() => void>()

export function getLang(): Lang {
  return currentLang
}

export function setLang(lang: Lang): void {
  currentLang = lang
  localStorage.setItem(STORAGE_KEY, lang)
  listeners.forEach(fn => fn())
}

export function t(key: TextKey): string {
  return texts[currentLang][key]
}

export function onLangChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
