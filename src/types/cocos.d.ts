/**
 * Cocos Creator 3.x 运行时最小类型（仅节点树只读浏览）
 */
declare namespace cc {
  interface Component {
    enabled: boolean;
    node: Node;
  }

  interface Node {
    uuid: string;
    name: string;
    active: boolean;
    children: Node[];
    parent: Node | null;
    getComponent<T extends Component>(ctor: { new (): T }): T | null;
  }

  interface Director {
    getScene(): Node | null;
    pause?: () => void;
    resume?: () => void;
    isPaused?: () => boolean;
  }

  interface Game {
    pause?: () => void;
    resume?: () => void;
  }

  const director: Director;
  const game: Game | undefined;
  const ENGINE_VERSION: string;
}

interface Window {
  cc: typeof cc;
}
