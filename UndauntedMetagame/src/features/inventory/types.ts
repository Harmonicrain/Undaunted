export type InventoryError = "forbidden" | "not_found" | "conflict" | "invalid_inventory_item" | "invalid_inventory_data" | "db_error";

export type InventoryResult<T = void> = { success: true, data?: T } | { success: false, error: InventoryError };

export class InventoryConflictError extends Error {
    constructor(message: string){
        super(message);
        this.name = "InventoryConflictError";
    }
}

export class InventoryValidationError extends Error {
    constructor(message: string){
        super(message);
        this.name = "InventoryValidationError";
    }
}
