# 卡密中心商品独立 API Key

在 Worker 中配置 `LICENSE_SERVICE_BASE_URL`（HTTPS 中心地址），并保留现有登录 Secret。商品凭据的加密密钥依次从 `AUTH_SECRET`、`NEXTAUTH_SECRET`、`OAUTH_CLIENT_SECRET` 中选择第一个非空值派生。

部署此版本后，在后台「数据库升级」执行 `0039_license_service_product_credentials`。该升级只创建 `card_service_credentials`，不修改原有商品或远端卡账本；普通页面访问不会自动执行建表。尚未升级时页面提示升级，接入和补货不可用。

在「卡密中心 → 商品供应配置」为每个商品填写 Program 和对应的 API Key。首次接入必须填写 Key；编辑时 Key 留空仅保留同一商品、同一 Program 已保存的凭据。输入新 Key 可更新该 Program 的凭据。新 Program 若没有保存过凭据，必须同时填写它的 Key。Key 必须具备所用操作的权限，包括分配、确认入库、销售、状态查询和退款作废。

运行时不再读取全局 `LICENSE_SERVICE_API_KEY` 作为商品凭据，也不借用其他商品的 Key。既有商品需逐个编辑并保存对应 Key；如果商品还有旧 Program 的库存或历史订单，应先为旧 Program 保存有效 Key，再切换到新 Program。历史分配按账本中的商品与 Program 查找凭据，不使用商品当前 Program 的 Key。

Key 使用 AES-GCM 加密后单独存储，配置快照、审计日志和页面只展示是否已配置。全量 JSON / SQL 备份包含凭据密文；SQL 备份恢复后，必须使用原来的登录 Secret 才能解密。更换登录 Secret 时需重新填写涉及当前和历史 Program 的 Key，不要仅改 Secret 后直接继续销售。

回滚代码时保留新增凭据表，无需删除或回退数据库结构。旧版代码只支持全局 Key，不能保持多 Program 的独立凭据行为；回滚前应暂停受影响商品，并恢复能匹配旧版的供应配置。回滚后再次升级可复用保留的密文（登录 Secret 未改变时）。
