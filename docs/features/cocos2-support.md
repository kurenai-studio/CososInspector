# Cocos Creator 2.x（含 2.4）支持

> 状态：**P0–P6 已落地**。P6 = 2.x 纹理导出合成到 originalSize（对齐 3.x engine）。

## 能力矩阵

| 能力 | 3.x | 2.x |
|------|-----|-----|
| Sprite 图集裁切 | ✓ | ✓ P1 |
| originalSize + offset 合成导出 | ✓ engine | ✓ P6（默认） |
| Spine / BMFont 自动绑入 | ✓ | ✓ P4b |
| MCP list/download Spine·BMFont | ✓ | ✓ P5 |

## P6：2.x 纹理引擎对齐

- `extractSpriteFrame` 默认 `path: 'engine'`：裁切(+反旋转)后按  
  `trimX=(ow-fw)/2+ox`、`trimY=(oh-fh)/2-oy` 贴到 `originalSize` 画布  
- `path: 'legacy'` 仅输出裁切帧（调试）  
- 面板预览 / `downloadTexture` / 复刻 `--with-textures` 默认吃到 originalSize PNG  

## P5：MCP 与路径匹配

MCP 工具：

- `cocos_list_spines` / `cocos_list_bmfonts`
- `cocos_download_spine` / `cocos_download_bmfont`

`scene-to-creator --with-spine-fonts` 先 `listSpines/listBmfonts`，按 path 对齐 live nodeId 再导出（与 Sprite 一致）。

## P4b：自动迁入

```powershell
npm run cocos-scene-to-creator -- tmp/<game>-scene-snapshot.json `
  --project D:/workspace/<proj> `
  --scene assets/scene/<game>_recovered.scene `
  --clear --with-textures --with-spine-fonts `
  --page-url-match <url片段> --ws-port 17373
```

- 资源落地：`assets/recovered/<key>/spine|bmfont/<name>/`
- 绑定：`sp.Skeleton.skeletonData` / `cc.Label.font`（eval + 磁盘补丁）
- 桥接 API：`downloadSpine` / `downloadBmfont`（share zip）

注意：Spine 运行时版本不一致时 Creator 可能无法导入，需用编辑器重导。

## 验收（P4b）

1. 带 `--with-spine-fonts` 跑通，日志出现 Spine/BMFont 解压与磁盘补丁  
2. 关闭场景不保存 → 重开，Skeleton/Label 已绑资源  

## 文档

详见 [scene-recovery.md](scene-recovery.md)。
