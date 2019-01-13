import {
  GraphQLSchema,
  GraphQLError,
  Source,
  print,
  parse,
  validate as validateDocument,
  FragmentDefinitionNode,
} from 'graphql';
import {DepGraph} from 'dependency-graph';

import {readDocument} from '../ast/document';
import {findDeprecatedUsages} from '../utils/graphql';

export interface InvalidDocument {
  source: Source;
  errors: GraphQLError[];
  deprecated: GraphQLError[];
}

export function validate(
  schema: GraphQLSchema,
  sources: Source[],
): InvalidDocument[] {
  const invalidDocuments: InvalidDocument[] = [];
  // read documents
  const documents = sources.map(readDocument);
  // keep all named fragments
  const fragments: Array<{node: FragmentDefinitionNode; source: string}> = [];
  const graph = new DepGraph<FragmentDefinitionNode>({circular: true});

  documents.forEach(doc => {
    doc.fragments.forEach(fragment => {
      fragments.push(fragment);
      graph.addNode(fragment.node.name.value, fragment.node);
    });
  });

  fragments.forEach(fragment => {
    const depends = extractFragments(print(fragment.node));

    if (depends) {
      depends.forEach(name => {
        graph.addDependency(fragment.node.name.value, name);
      });
    }
  });

  documents
    // since we include fragments, validate only operations
    .filter(doc => doc.hasOperations)
    .forEach(doc => {
      const merged = `
        ${doc.source.body}

        ${(extractFragments(doc.source.body) || [])
          // resolve all nested fragments
          .map(fragmentName =>
            resolveFragment(graph.getNodeData(fragmentName), graph),
          )
          // flatten arrays
          .reduce((list, current) => list.concat(current), [])
          // remove duplicates
          .filter(
            (def, i, all) =>
              all.findIndex(item => item.name.value === def.name.value) === i,
          )
          // does not include fragment definition
          .filter(
            fragment =>
              doc.source.body.indexOf(`fragment ${fragment.name.value} on`) ===
              -1,
          )
          // print
          .map(print)
          // merge
          .join('\n\n')}
      `;

      const errors = validateDocument(schema, parse(merged)) as GraphQLError[];
      const deprecated = findDeprecatedUsages(schema, parse(doc.source.body));

      if (errors || deprecated) {
        invalidDocuments.push({
          source: doc.source,
          errors,
          deprecated,
        });
      }
    });

  return invalidDocuments;
}

//
// PostInfo -> AuthorInfo
// AuthorInfo -> None
//
function resolveFragment(
  fragment: FragmentDefinitionNode,
  graph: DepGraph<FragmentDefinitionNode>,
): FragmentDefinitionNode[] {
  return graph
    .dependenciesOf(fragment.name.value)
    .reduce(
      (list, current) => [
        ...list,
        ...resolveFragment(graph.getNodeData(current), graph),
      ],
      [fragment],
    );
}

function extractFragments(document: string): string[] | undefined {
  return (document.match(/[\.]{3}[a-z0-9\_]+\b/gi) || []).map(name =>
    name.replace('...', ''),
  );
}
