import type {Tx} from '../storage/store.js';
import type {RepositoryProblem} from './types.js';
import {inputHash} from './inspect.js';
/** Canonical state and its browser invalidation share one durable transaction. */
export function putRepositoryProblem(tx:Tx,problem:RepositoryProblem){if(inputHash(tx.get('repository-problem',problem.id)??null)===inputHash(problem))return;tx.put('repository-problem',problem.id,problem);tx.emit('repository.problem',{problemId:problem.id,revision:problem.revision,state:problem.state});}
