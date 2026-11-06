import { Test, TestingModule } from '@nestjs/testing';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';

describe('CatalogController', () => {
  let catalogController: CatalogController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [CatalogController],
      providers: [CatalogService],
    }).compile();

    catalogController = app.get<CatalogController>(CatalogController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(catalogController.getHello()).toBe('Hello World!');
    });
  });
});
