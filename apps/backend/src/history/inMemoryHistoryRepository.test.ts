import { describeHistoryRepositoryContract } from "./historyRepositoryContract.js";
import { createInMemoryHistoryRepository } from "./inMemoryHistoryRepository.js";

describeHistoryRepositoryContract(() => createInMemoryHistoryRepository());
