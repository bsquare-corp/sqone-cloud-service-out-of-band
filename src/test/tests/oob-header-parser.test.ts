import { expect } from 'chai';
import { describe, it } from 'mocha';
import { parseOobHeader } from '../../oob-header-parser';

describe('OOB Header Parser', () => {
  it('Parse expected header with bootId', () => {
    expect(parseOobHeader("uuid '977fb93c-92a5-4df0-bc36-aa332c183489';")).to.deep.equal({
      uuid: '977fb93c-92a5-4df0-bc36-aa332c183489',
    });
  });

  it('Parse expected header with bootId, no semi-colon', () => {
    expect(parseOobHeader("uuid '977fb93c-92a5-4df0-bc36-aa332c183489'")).to.deep.equal({
      uuid: '977fb93c-92a5-4df0-bc36-aa332c183489',
    });
  });

  it('Parse header with multiple values', () => {
    expect(
      parseOobHeader("uuid '977fb93c-92a5-4df0-bc36-aa332c183489'; test 'test'"),
    ).to.deep.equal({
      uuid: '977fb93c-92a5-4df0-bc36-aa332c183489',
      test: 'test',
    });
  });

  it('Parse header with empty value', () => {
    expect(parseOobHeader("uuid '';")).to.deep.equal({
      uuid: '',
    });
  });

  it('Parse header with missing quotes throws', () => {
    expect(() => parseOobHeader('uuid 977fb93c-92a5-4df0-bc36-aa332c183489;')).to.throw();
  });

  it('Parse header with missing value throws', () => {
    expect(() => parseOobHeader('uuid ;')).to.throw();
  });

  it('Parse header with missing space throws', () => {
    expect(() => parseOobHeader('uuid;')).to.throw();
  });
});
