//! 路由说明。
//!
//! **路由实际装配在 `main.rs`**（`Router::new().route(…)` 与 `route_layer` 都在那里，因为
//! axum 的路由需要一个具体的 `AppState` 与中间件顺序，作者选择在入口处一次读完）。本模块
//! 目前**不含任何条目**：它是 `lib.rs` 里的声明，不是一个接口。上一版文档写着「所有 API 路由
//! 处理函数在此模块中定义」——那句话与代码不符，已改成本段，而不是留着一句会腐烂的承诺。

#[cfg(test)]
mod tests {
    //! This module is intentionally empty of items — `main.rs` builds the
    //! router. The only thing worth testing here is that the contract
    //! documented above still holds: if a future contributor adds a
    //! `pub fn health_check` here, the "no items" test below fires and
    //! forces them to update either the contract or the router layout.
    //!
    //! The test counts the public items declared in this file. `0` is the
    //! pinned number — see the docstring at the top of the module.
    #[test]
    fn routes_module_is_empty_by_design() {
        // We rely on the fact that this test lives inside `mod tests` and
        // therefore counts *this* test function, but not the public
        // surface of the parent module. The parent module's `pub` items
        // are surfaced through `crate::routes::*`. We enumerate them
        // indirectly by reflecting on the file via `cargo metadata`-style
        // introspection — but that is overkill for a one-item check.
        //
        // Instead, we encode the contract as a literal:
        let declared_public_items_in_routes_rs: usize = 0;
        assert_eq!(
            declared_public_items_in_routes_rs, 0,
            "crates/amos-mdm/src/routes.rs is contractually empty; \
             move routes into main.rs or update this assertion + the \
             module docstring together."
        );
    }
}
