export default () => {
  return [
    {
      name: 'app_closeCurrentTab',
      shortcut: 'alt+w',
      shortcutMac: 'alt+w'
    },
    {
      name: 'app_mouseWheelDownCloseTab',
      shortcut: 'mouseWheel',
      shortcutMac: 'mouseWheel',
      readonly: true
    },
    {
      name: 'app_reloadCurrentTab',
      shortcut: 'alt+r',
      shortcutMac: 'alt+r'
    },
    {
      name: 'app_reloadAll',
      shortcut: 'alt+y',
      shortcutMac: 'alt+y'
    },
    {
      name: 'app_cloneToNextLayout',
      shortcut: 'alt+/',
      shortcutMac: 'alt+/'
    },
    {
      name: 'app_duplicateTab',
      shortcut: 'alt+c',
      shortcutMac: 'alt+c'
    },
    {
      // unbound by default, users set it in the shortcut settings
      name: 'app_stopQuickCommand',
      shortcut: '',
      shortcutMac: ''
    },
    {
      name: 'app_newBookmark',
      shortcut: 'ctrl+n',
      shortcutMac: 'meta+n'
    },
    {
      name: 'app_newTab',
      shortcut: 'alt+q',
      shortcutMac: 'alt+q'
    },
    {
      name: 'app_toggleAddBtn',
      shortcut: 'alt+n',
      shortcutMac: 'alt+n'
    },
    {
      name: 'app_togglefullscreen',
      shortcut: 'alt+f',
      shortcutMac: 'alt+f'
    },
    {
      name: 'app_zoomin',
      shortcut: 'ctrl+=',
      shortcutMac: 'meta+='
    },
    {
      name: 'app_zoomout',
      shortcut: 'ctrl+-',
      shortcutMac: 'meta+-'
    },
    {
      name: 'app_prevTab',
      shortcut: 'ctrl+shift+tab',
      shortcutMac: 'ctrl+shift+tab'
    },
    {
      name: 'app_nextTab',
      shortcut: 'ctrl+tab',
      shortcutMac: 'ctrl+tab'
    },
    {
      // 1-8: that tab of the current layout part, 9: the last one (#1950).
      // Not ctrl: ctrl+2 is the default global hotkey (show / hide electerm),
      // and ctrl+alt is AltGr on many keyboards ({ [ ] } on German ones)
      name: 'app_switchToTab',
      shortcut: 'alt+1,alt+2,alt+3,alt+4,alt+5,alt+6,alt+7,alt+8,alt+9',
      shortcutMac: 'meta+1,meta+2,meta+3,meta+4,meta+5,meta+6,meta+7,meta+8,meta+9'
    },
    {
      name: 'terminal_clear',
      shortcut: 'ctrl+l,ctrl+shift+l',
      shortcutMac: 'meta+l'
    },
    // {
    //   name: 'terminal_selectAll',
    //   shortcut: 'ctrl+a,ctrl+shift+a',
    //   shortcutMac: 'meta+a',
    //   skipMac: true,
    //   readonly: true
    // },
    {
      name: 'terminal_copy',
      shortcut: 'ctrl+c,ctrl+shift+c',
      shortcutMac: 'meta+c',
      skipMac: true,
      readonly: true
    },
    {
      name: 'terminal_paste',
      shortcut: 'ctrl+v,ctrl+shift+v',
      shortcutMac: 'meta+v',
      readonly: true
    },
    {
      name: 'terminal_search',
      shortcut: 'ctrl+f',
      shortcutMac: 'meta+f'
    },
    {
      name: 'terminal_pasteSelected',
      shortcut: 'alt+insert',
      shortcutMac: 'alt+insert'
    },
    {
      name: 'terminal_showNormalBuffer',
      shortcut: 'ctrl+ArrowUp',
      shortcutMac: 'meta+↑'
    },
    {
      name: 'terminal_zoominTerminal',
      shortcut: 'ctrl+▲',
      shortcutMac: 'meta+▲'
    },
    {
      name: 'terminal_zoomoutTerminal',
      shortcut: 'ctrl+▼',
      shortcutMac: 'meta+▼'
    },
    {
      name: 'terminal_syncSftpPath',
      shortcut: 'alt+shift+f11',
      shortcutMac: 'alt+shift+f11'
    }
  ]
}
