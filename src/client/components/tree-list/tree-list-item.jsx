/**
 * tree list for bookmarks
 */

import { memo } from 'react'
import { Dropdown } from 'antd'
import Modal from '../common/modal'
import { wakeBookmark } from '../../common/wake-on-lan'
import { createTitleTag } from '../../common/create-title'
import classnames from 'classnames'
import highlight from '../common/highlight'
import uid from '../../common/uid'

function areEqual (prevProps, nextProps) {
  const prevSelected = prevProps.selectedItemId === prevProps.item.id
  const nextSelected = nextProps.selectedItemId === nextProps.item.id
  const prevRowSelected = Boolean(prevProps.rowSelected)
  const nextRowSelected = Boolean(nextProps.rowSelected)

  return prevProps.isGroup === nextProps.isGroup &&
    prevProps.parentId === nextProps.parentId &&
    prevProps.staticList === nextProps.staticList &&
    prevProps.keyword === nextProps.keyword &&
    prevProps.indentCapped === nextProps.indentCapped &&
    prevSelected === nextSelected &&
    prevRowSelected === nextRowSelected &&
    prevProps.item.id === nextProps.item.id &&
    prevProps.itemLevel === nextProps.itemLevel &&
    prevProps.itemColor === nextProps.itemColor &&
    prevProps.itemDescription === nextProps.itemDescription &&
    prevProps.itemLabel === nextProps.itemLabel &&
    prevProps.itemPath === nextProps.itemPath
}

const e = window.translate

/**
 * right click menu of a bookmark, the actions of the hover icons
 * (tree-item-op.jsx). Also in the sidebar list, where the icons only edit:
 * that is the list people work with every day
 * @return {{key: string, label: string, onClick: function}[]}
 */
function bookmarkMenuItems (props) {
  const { item } = props
  return [{
    key: 'edit',
    label: e('edit'),
    onClick: ev => props.editItem(ev, item, false)
  }, {
    key: 'duplicate',
    label: e('duplicate'),
    onClick: ev => props.duplicateItem(ev, item)
  }, {
    key: 'move',
    label: e('moveTo'),
    onClick: ev => props.openMoveModal(ev, item, false)
  }, {
    key: 'del',
    label: e('del'),
    danger: true,
    onClick: ev => {
      ev.stopPropagation()
      Modal.confirm({
        title: e('del') + '?',
        content: props.itemLabel,
        okText: e('del'),
        cancelText: e('cancel'),
        onOk: () => props.del(item, { stopPropagation () {} })
      })
    }
  }, {
    // asks for the MAC when the bookmark has none, see wake-on-lan.jsx
    key: 'wol',
    label: 'Wake on LAN',
    onClick: () => wakeBookmark(item.id)
  }]
}

function TreeListItem (props) {
  const onSelect = (e) => {
    props.onSelect(e)
  }

  const onDragOver = e => {
    props.onDragOver(e)
  }

  const onDragStart = e => {
    props.onDragStart(e)
  }

  const onDragEnter = e => {
    props.onDragEnter(e)
  }

  const onDragLeave = e => {
    props.onDragLeave(e)
  }

  const onDrop = e => {
    props.onDrop(e)
  }

  const {
    item,
    isGroup,
    selectedItemId
  } = props
  const cls = classnames(
    {
      selected: selectedItemId === item.id,
      // the keyboard cursor: the row the arrow keys are on, enter acts on it
      'kb-selected': props.rowSelected
    },
    'tree-item',
    {
      'is-category': isGroup,
      level2: item.level === 2
    }
  )
  const tag = isGroup ? '' : createTitleTag(item)
  const colorTag = isGroup && item.color
    ? (
      <span
        className='category-color-tag'
        style={{
          backgroundColor: item.color
        }}
      />
      )
    : null
  const title = isGroup
    ? item.title
    : props.itemLabel
  // the ancestor path first: with the indent capped, the row's own position in
  // the tree is no longer readable from the left edge alone
  const pathPrefix = props.itemPath ? props.itemPath + ' / ' : ''
  const titleAll = pathPrefix + title + (item.description ? ' - ' + item.description : '')
  // depth marker for rows the indent cap has stopped moving right, otherwise a
  // depth-6 row and a depth-9 row look like siblings. A single narrow glyph: it
  // sits in the text line of a panel that is already short of width.
  const depthMark = props.indentCapped
    ? <span className='tree-item-depth-mark'>›</span>
    : null
  const titleHighlight = isGroup
    ? item.title || 'no title'
    : highlight(
      title,
      props.keyword
    )
  const propsAll = {
    className: cls,
    title: titleAll,
    draggable: true,
    'data-item-id': item.id,
    'data-parent-id': props.parentId,
    'data-is-group': isGroup ? 'true' : 'false',
    onDragOver,
    onDragStart,
    onDragEnter,
    onDragLeave,
    onDrop
  }
  const titleProps = {
    className: 'tree-item-title elli',
    onClick: onSelect,
    'data-item-id': item.id,
    'data-is-group': isGroup ? 'true' : 'false',
    'data-parent-id': props.parentId
  }
  const key = item.id || uid()
  const titleElem = (
    <div
      {...titleProps}
    >
      {depthMark}{colorTag}{tag}{titleHighlight}
    </div>
  )
  if (isGroup || !item.id) {
    return (
      <div
        {...propsAll}
        key={key}
      >
        {titleElem}
      </div>
    )
  }
  // built on open: the item prop is memoized and may be stale
  const menu = {
    items: bookmarkMenuItems(props).map(({ onClick, ...rest }) => rest),
    onClick: ({ key, domEvent }) => {
      domEvent.stopPropagation()
      bookmarkMenuItems(props).find(i => i.key === key)?.onClick(domEvent)
    }
  }
  return (
    <div
      {...propsAll}
      key={key}
    >
      <Dropdown menu={menu} trigger={['contextMenu']}>
        {titleElem}
      </Dropdown>
    </div>
  )
}

export default memo(TreeListItem, areEqual)
