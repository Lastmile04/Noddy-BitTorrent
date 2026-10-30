type NodeType = "BYTE_STRING" | "INTEGER" | "LIST" | "DICT";

interface BaseNode {
    type: NodeType;
}

export interface ByteStringNode extends BaseNode {
    type: "BYTE_STRING";
    value: Buffer; // Raw memory representation
}

export interface IntegerNode extends BaseNode {
    type: "INTEGER";
    value: number;
}

export interface ListNode extends BaseNode {
    type: "LIST";
    value: Node[]; // Zero or more arbitrary AST nodes
}

export interface DictNode extends BaseNode {
    type: "DICT";
    value: [ByteStringNode, Node][];   // Array of key-value pairs protecting structural correctness
}

export interface ParseResult<T extends Node = Node> {
    node: T,
    nextOffset: number,
}

// The Unified Node Family: This is the Discriminated Union
export type Node = ByteStringNode | IntegerNode | ListNode | DictNode;
