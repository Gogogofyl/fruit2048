/**
 * 本地存档适配：接口与原 H5 版 LocalStorageManager 保持一致，
 * 底层走 Platform（tt.storage / localStorage 降级）。
 * 云端存档与全网榜在 P2 阶段叠加，不改变本接口。
 */
function StorageManager() {
  this.bestScoreKey = 'bestScore';
  this.gameStateKey = 'gameState';
}

StorageManager.prototype.getBestScore = function () {
  return Platform.getStorage(this.bestScoreKey, 0) || 0;
};

StorageManager.prototype.setBestScore = function (score) {
  Platform.setStorage(this.bestScoreKey, score);
};

StorageManager.prototype.getGameState = function () {
  return Platform.getStorage(this.gameStateKey, null);
};

StorageManager.prototype.setGameState = function (gameState) {
  Platform.setStorage(this.gameStateKey, gameState);
};

StorageManager.prototype.clearGameState = function () {
  Platform.removeStorage(this.gameStateKey);
};

globalThis.StorageManager = StorageManager;
