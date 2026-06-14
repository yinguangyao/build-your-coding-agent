---
description: 给本项目发版。当用户说"发版""发布新版本""bump version"时使用。
---

发版步骤：

1. 跑 `./bump-version.sh <major|minor|patch>` 更新 package.json（脚本在本 skill 目录里）
2. 跑测试：`npm test`，全绿才继续
3. 打 tag 并推送：`git tag v$(node -p "require('./package.json').version") && git push --tags`
