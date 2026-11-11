# PRISM 工程规格校验记录

UTC 2026-11-07T23:13:29.114872+00:00

```json
{
  "contract": {
    "exit_code": 0,
    "output": "{\"openapi\": \"3.1.1\", \"paths\": 72, \"operations\": 118, \"schemas\": 129, \"resolved_refs\": 683}\n"
  },
  "database": {
    "exit_code": 0,
    "output": "{\"status\":\"passed\",\"engine\":\"PGlite PostgreSQL WASM\",\"checks\":26,\"tables\":42,\"limitation\":\"No multi-connection concurrency or application handler tests\"}\n"
  },
  "pglite_version": "0.5.15",
  "validator_version": "0.8.5",
  "runtime": "/var/folders/mb/lwm47k8d06l94_d03rn_sj900000gn/T/prism-validation-fg_9ijxr"
}
```

范围：OpenAPI 格式与引用、接口前置条件、PostgreSQL DDL 和关键约束。内存引擎不能替代真实多连接并发、FSRS handler、客户端同步、备份恢复和性能验收。
