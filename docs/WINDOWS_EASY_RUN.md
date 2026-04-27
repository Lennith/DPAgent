# MiniMax Agent Windows 易用启动说明

这个文档对应的是发布包里的“开箱即用”启动方式。

如果你使用的是源码仓库或 npm 包，请优先看 [USER_GUIDE.md](./USER_GUIDE.md)。

## 1. 使用步骤

1. 把发布包解压到一个可写目录
2. 双击 `Run-MiniMax.bat`
3. 程序会启动本地 Web 服务
4. 浏览器默认打开 `http://localhost:53721`
5. 在 Settings 里填写 API Key 后即可开始使用

## 2. 运行前提

易用包依赖以下内容完整存在：

- `config.yaml`
- `dist/web/server/index.js`
- `dist/web/client/index.html`

如果发布包缺这些文件，说明包不完整。

## 3. 当前行为

- 固定端口：`53721`
- 会自动尝试打开浏览器
- 允许在启动时先没有 API Key，先开 UI，再在 Settings 中补
- 运行期间会在本地生成：
  - `contexts/`
  - `runtime/`
  - `logs/`

## 4. 常见问题

### 4.1 浏览器没有自动打开

可以手动访问：

```text
http://localhost:53721
```

### 4.2 `Port 53721 is already in use`

说明本机已经有进程占用了 `53721`。  
先停止占用进程，再重新启动。

### 4.3 `API Key is not configured`

这是正常的首次启动状态。  
进入 Settings，填写有效 API Key 并保存即可。

### 4.4 `Access denied`

通常是解压目录没有写权限。  
请把发布包移动到一个普通可写目录再启动。

## 5. 建议

- 不要把发布包放到系统保护目录
- 优先在项目目录或专用工作目录中运行
- 如果你要长期使用，建议配合 [../CONFIG.md](../CONFIG.md) 调整工作目录和 toolset
