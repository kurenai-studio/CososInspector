# Cocos Creator 2.x（含 2.4）支持

> 状态：**P0–P4b 已落地**。P4b = `scene-to-creator --with-spine-fonts` 自动导出并绑定 Spine/BMFont。

## 能力矩阵

| 能力 | 3.x | 2.x |
|------|-----|-----|
| 场景复刻 Sprite/UI/Label/Widget | ✓ | ✓ |
| Spine / BMFont zip 面板导出 | ✓ | ✓ P4a |
| Spine / BMFont **自动绑入 Creator** | ✓ P4b | ✓ P4b |

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
